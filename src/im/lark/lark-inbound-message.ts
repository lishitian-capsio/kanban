/**
 * Pure (network-free) normalization of a Lark `im.message.receive_v1` event into the neutral shape
 * the IM gateway routes on. Kept separate from the connector so every decode decision — content
 * parsing, mention substitution, image-key extraction, the skip conditions — is unit-testable with
 * no transport or credentials.
 *
 * Input is the object the SDK's `EventDispatcher` hands a registered handler: for a v2 event it is
 * the header and event bodies merged flat (so `event_id`, `sender`, `message` all sit at top level;
 * see the SDK's `dispatcher/request-handle.ts#parse`). We read defensively from `unknown` and never
 * trust the shape.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content
 */

/** A message image to download later: the message it belongs to plus its Lark `image_key`. */
export interface NormalizedLarkImageRef {
	messageId: string;
	fileKey: string;
}

/** The neutral inbound message extracted from a Lark event (before image bytes are fetched). */
export interface NormalizedLarkInboundMessage {
	/** The Lark `chat_id` — the routing layer maps this to a session binding. */
	channelKey: string;
	/** The sender's `open_id` (falling back to `union_id`, then `user_id`), or `""` when unknown. */
	senderId: string;
	/** The plain-text body (mentions substituted, post segments flattened). May be `""` when images-only. */
	text: string;
	/** Image resources the message carried, to be downloaded + base64-encoded by the connector. */
	images: NormalizedLarkImageRef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Extract the header `event_id` (used for idempotent dedup); `undefined` when absent. */
export function parseLarkInboundEventId(data: unknown): string | undefined {
	return isRecord(data) ? asString(data.event_id) : undefined;
}

/** Resolve the sender id, preferring `open_id`, then `union_id`, then `user_id`. */
function extractSenderId(sender: unknown): string {
	if (!isRecord(sender)) return "";
	const id = sender.sender_id;
	if (!isRecord(id)) return "";
	return asString(id.open_id) ?? asString(id.union_id) ?? asString(id.user_id) ?? "";
}

/** Replace `@_user_N` mention placeholders in a text body with `@<name>` using the `mentions` array. */
function substituteMentions(text: string, mentions: unknown): string {
	if (!Array.isArray(mentions)) return text;
	let out = text;
	for (const mention of mentions) {
		if (!isRecord(mention)) continue;
		const key = asString(mention.key);
		const name = asString(mention.name);
		if (key && name) {
			out = out.split(key).join(`@${name}`);
		}
	}
	return out;
}

/** The `post` body's inner `{ title, content }`, unwrapping the `{ post: { <locale>: … } }` envelope. */
function unwrapPostBody(content: Record<string, unknown>): Record<string, unknown> | null {
	const post = content.post;
	if (isRecord(post)) {
		const firstLocale = Object.values(post).find(isRecord);
		return firstLocale ?? null;
	}
	// Locale-less shape: content already carries `title` / `content` directly.
	if ("content" in content || "title" in content) {
		return content;
	}
	return null;
}

/** Render one post segment to text, collecting any embedded image into `images`. */
function renderPostSegment(segment: unknown, images: NormalizedLarkImageRef[], messageId: string): string {
	if (!isRecord(segment)) return "";
	switch (segment.tag) {
		case "text":
		case "a":
			return asString(segment.text) ?? "";
		case "at": {
			const name = asString(segment.user_name) ?? asString(segment.user_id) ?? "";
			return name ? `@${name}` : "";
		}
		case "img": {
			const key = asString(segment.image_key);
			if (key) images.push({ messageId, fileKey: key });
			return "";
		}
		default:
			return "";
	}
}

/** Flatten a `post` message's title + segment matrix into text, collecting embedded images. */
function extractPost(body: Record<string, unknown>, images: NormalizedLarkImageRef[], messageId: string): string {
	const lines: string[] = [];
	const title = asString(body.title);
	if (title) lines.push(title);
	const matrix = body.content;
	if (Array.isArray(matrix)) {
		for (const line of matrix) {
			if (!Array.isArray(line)) continue;
			lines.push(line.map((seg) => renderPostSegment(seg, images, messageId)).join(""));
		}
	}
	return lines.join("\n");
}

/**
 * Normalize a Lark `im.message.receive_v1` payload into a {@link NormalizedLarkInboundMessage}.
 * Returns `null` (the event is skipped) when the payload is malformed, has no `chat_id`, has
 * unparseable content, or is an unsupported type carrying neither text nor images.
 */
export function normalizeLarkInboundMessage(data: unknown): NormalizedLarkInboundMessage | null {
	if (!isRecord(data)) return null;
	const message = data.message;
	if (!isRecord(message)) return null;

	const channelKey = asString(message.chat_id);
	if (!channelKey) return null;

	const messageId = asString(message.message_id) ?? "";
	const rawContent = asString(message.content);
	if (rawContent === undefined) return null;

	let content: unknown;
	try {
		content = JSON.parse(rawContent);
	} catch {
		return null;
	}
	if (!isRecord(content)) return null;

	const images: NormalizedLarkImageRef[] = [];
	let text = "";

	switch (message.message_type) {
		case "text": {
			text = substituteMentions(asString(content.text) ?? "", message.mentions);
			break;
		}
		case "post": {
			const body = unwrapPostBody(content);
			if (body) text = substituteMentions(extractPost(body, images, messageId), message.mentions);
			break;
		}
		case "image": {
			const key = asString(content.image_key);
			if (key) images.push({ messageId, fileKey: key });
			break;
		}
		default:
			// Unsupported types (file / audio / media / sticker / …) carry no text or image we can
			// route today; fall through with empty text + no images so they are skipped below.
			break;
	}

	text = text.trim();
	if (text === "" && images.length === 0) return null;

	return { channelKey, senderId: extractSenderId(data.sender), text, images };
}
