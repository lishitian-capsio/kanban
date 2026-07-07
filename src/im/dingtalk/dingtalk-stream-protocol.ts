/**
 * Pure (network-free) helpers for the DingTalk **Stream-mode** inbound long connection — credential
 * parsing, open-request construction, WebSocket frame decode/classify, ack/pong framing, and the
 * platform-native bot-message → {@link ImInboundMessageEvent} mapping. Kept separate from the
 * connector (`./dingtalk-stream-connector`) so every protocol decision is unit-testable without a
 * transport, a socket, or credentials, mirroring how the outbound adapter splits its payload/URL
 * helpers (`./dingtalk-message`) from the provider.
 *
 * Stream mode (钉钉 Stream / 长连接): the app opens a connection endpoint over HTTP, then connects a
 * WebSocket to the returned `endpoint?ticket=…`. Downstream frames arrive as JSON with a top-level
 * `type` (`SYSTEM` for ping/disconnect, `CALLBACK` for subscribed bot messages), a `headers.topic`,
 * a `headers.messageId` used to correlate the client's ack, and a JSON-string `data` payload. Each
 * frame MUST be acked with a `{code:200,…}` response carrying the same `messageId`.
 *
 * @see https://open.dingtalk.com/document/orgapp/stream
 */
import type { ImInboundMessageEvent } from "../gateway/inbound-event";
import { DingtalkStreamCredentialFormatError } from "./errors";

/** HTTP endpoint that mints a Stream WebSocket `endpoint` + `ticket` for an app credential. */
export const DINGTALK_STREAM_OPEN_ENDPOINT = "https://api.dingtalk.com/v1.0/gateway/connections/open";

/** CALLBACK topic carrying an inbound bot message (group or single chat). */
export const DINGTALK_BOT_MESSAGE_TOPIC = "/v1.0/im/bot/messages/get";

/** SYSTEM topic: a keep-alive ping the client must echo back as a 200 ack. */
export const DINGTALK_SYSTEM_PING_TOPIC = "ping";

/** SYSTEM topic: the server is about to close this connection; the client should reconnect. */
export const DINGTALK_SYSTEM_DISCONNECT_TOPIC = "disconnect";

/** Frame `type` for platform system control frames (ping / disconnect). */
export const DINGTALK_FRAME_TYPE_SYSTEM = "SYSTEM";

/** Default user-agent reported when opening the Stream connection. */
export const DINGTALK_STREAM_DEFAULT_UA = "kanban-im-gateway/1.0";

/**
 * A DingTalk enterprise-bot app credential parsed out of the opaque
 * {@link ImOutboundCredential.botToken}. Stream mode authenticates with the app's `appKey` +
 * `appSecret`, colon-joined in the single `botToken` field — the same convention the Lark adapter
 * uses for `"<app_id>:<app_secret>"`.
 */
export interface DingtalkStreamCredential {
	appKey: string;
	appSecret: string;
}

/** The HTTP body posted to {@link DINGTALK_STREAM_OPEN_ENDPOINT} to open a Stream connection. */
export interface DingtalkOpenRequest {
	clientId: string;
	clientSecret: string;
	subscriptions: { type: string; topic: string }[];
	ua: string;
	localIp: string;
}

/** A decoded downstream Stream frame; `data` is the still-raw (JSON-string) payload. */
export interface DingtalkStreamFrame {
	type: string;
	topic: string;
	messageId: string;
	data: string;
}

/** A normalized inbound bot message plus the key used to de-duplicate at-least-once redeliveries. */
export interface DecodedDingtalkMessage {
	/** Stable per-message id (`msgId`) for idempotent dedup; `""` when the payload omitted it. */
	dedupKey: string;
	event: ImInboundMessageEvent;
}

/**
 * Parse `"<appKey>:<appSecret>"` out of the stored {@link ImOutboundCredential.botToken}. Splits on
 * the FIRST colon only (a secret containing a colon survives intact). Throws
 * {@link DingtalkStreamCredentialFormatError} when either half is missing/blank.
 */
export function parseDingtalkStreamCredential(botToken: string): DingtalkStreamCredential {
	const separator = botToken.indexOf(":");
	if (separator <= 0) {
		throw new DingtalkStreamCredentialFormatError();
	}
	const appKey = botToken.slice(0, separator).trim();
	const appSecret = botToken.slice(separator + 1).trim();
	if (!appKey || !appSecret) {
		throw new DingtalkStreamCredentialFormatError();
	}
	return { appKey, appSecret };
}

/** Build the Stream open-connection request body for a credential (subscribes to bot messages). */
export function buildDingtalkOpenRequest(
	credential: DingtalkStreamCredential,
	options: { ua?: string; localIp?: string } = {},
): DingtalkOpenRequest {
	return {
		clientId: credential.appKey,
		clientSecret: credential.appSecret,
		subscriptions: [{ type: "CALLBACK", topic: DINGTALK_BOT_MESSAGE_TOPIC }],
		ua: options.ua ?? DINGTALK_STREAM_DEFAULT_UA,
		localIp: options.localIp ?? "127.0.0.1",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Parse a raw downstream WebSocket frame into {@link DingtalkStreamFrame}. Returns `null` for
 * non-JSON input or a frame missing its `type` / `headers.topic` / `headers.messageId`, so a
 * malformed frame is skipped rather than throwing on the socket's message path.
 */
export function parseDingtalkStreamFrame(raw: string): DingtalkStreamFrame | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !isRecord(parsed.headers)) {
		return null;
	}
	const { type } = parsed;
	const { topic, messageId } = parsed.headers;
	if (typeof type !== "string" || typeof topic !== "string" || typeof messageId !== "string") {
		return null;
	}
	const data = typeof parsed.data === "string" ? parsed.data : "";
	return { type, topic, messageId, data };
}

/** True for a SYSTEM keep-alive ping frame. */
export function isDingtalkPingFrame(frame: DingtalkStreamFrame): boolean {
	return frame.type === DINGTALK_FRAME_TYPE_SYSTEM && frame.topic === DINGTALK_SYSTEM_PING_TOPIC;
}

/** True for a SYSTEM disconnect frame (the server asking the client to reconnect). */
export function isDingtalkDisconnectFrame(frame: DingtalkStreamFrame): boolean {
	return frame.type === DINGTALK_FRAME_TYPE_SYSTEM && frame.topic === DINGTALK_SYSTEM_DISCONNECT_TOPIC;
}

/** True for a subscribed inbound bot-message frame. */
export function isDingtalkBotMessageFrame(frame: DingtalkStreamFrame): boolean {
	return frame.topic === DINGTALK_BOT_MESSAGE_TOPIC;
}

/**
 * Build the 200 ack frame a client sends for each downstream frame, echoing its `messageId`. Also
 * used to answer a ping (pass the ping's `data` so it is echoed back verbatim).
 */
export function buildDingtalkAckFrame(messageId: string, data: string = "{}"): string {
	return JSON.stringify({
		code: 200,
		headers: { contentType: "application/json", messageId },
		message: "OK",
		data,
	});
}

/** Concatenate the `text` segments of a DingTalk richText payload, ignoring non-text segments. */
function flattenRichText(content: unknown): string {
	if (!isRecord(content) || !Array.isArray(content.richText)) {
		return "";
	}
	return content.richText
		.map((segment) => (isRecord(segment) && typeof segment.text === "string" ? segment.text : ""))
		.join("");
}

/**
 * Map a DingTalk bot-message `data` payload (the JSON string from a {@link DINGTALK_BOT_MESSAGE_TOPIC}
 * frame) onto a normalized {@link ImInboundMessageEvent}. Returns `null` — the caller still acks the
 * frame — when the payload is unparseable, lacks a conversation/sender, is an unsupported message
 * type, or carries no text. Currently handles `text` and `richText`; image download (via
 * `downloadCode`) is a deliberate later extension, mirroring the outbound adapter's 单聊 note.
 */
export function decodeDingtalkBotMessage(dataJson: string): DecodedDingtalkMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(dataJson);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}

	const channelKey = typeof parsed.conversationId === "string" ? parsed.conversationId.trim() : "";
	const senderStaffId = typeof parsed.senderStaffId === "string" ? parsed.senderStaffId.trim() : "";
	const senderRawId = typeof parsed.senderId === "string" ? parsed.senderId.trim() : "";
	const senderId = senderStaffId || senderRawId;
	if (!channelKey || !senderId) {
		return null;
	}

	let text = "";
	if (parsed.msgtype === "text" && isRecord(parsed.text) && typeof parsed.text.content === "string") {
		text = parsed.text.content.trim();
	} else if (parsed.msgtype === "richText") {
		text = flattenRichText(parsed.content).trim();
	}
	if (!text) {
		return null;
	}

	const dedupKey = typeof parsed.msgId === "string" ? parsed.msgId : "";
	return {
		dedupKey,
		event: { kind: "message", platform: "dingtalk", channelKey, text, senderId },
	};
}
