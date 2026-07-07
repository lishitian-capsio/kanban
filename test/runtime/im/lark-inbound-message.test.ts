import { describe, expect, it } from "vitest";

import { normalizeLarkInboundMessage, parseLarkInboundEventId } from "../../../src/im/lark/lark-inbound-message";

/** Build a v2 `im.message.receive_v1` handler payload (header + event fields merged flat, as the SDK's EventDispatcher delivers it). */
function makeEvent(overrides: {
	eventId?: string;
	senderOpenId?: string;
	senderUnionId?: string;
	senderUserId?: string;
	chatId?: string;
	messageId?: string;
	messageType?: string;
	content?: unknown;
	mentions?: unknown;
}): unknown {
	const message: Record<string, unknown> = {
		message_id: overrides.messageId ?? "om_1",
		chat_id: overrides.chatId ?? "oc_chat",
		chat_type: "group",
		message_type: overrides.messageType ?? "text",
		content:
			typeof overrides.content === "string"
				? overrides.content
				: JSON.stringify(overrides.content ?? { text: "hi" }),
	};
	if (overrides.mentions !== undefined) {
		message.mentions = overrides.mentions;
	}
	const sender_id: Record<string, unknown> = {};
	if (overrides.senderOpenId !== undefined) sender_id.open_id = overrides.senderOpenId;
	if (overrides.senderUnionId !== undefined) sender_id.union_id = overrides.senderUnionId;
	if (overrides.senderUserId !== undefined) sender_id.user_id = overrides.senderUserId;
	return {
		event_id: overrides.eventId ?? "evt_1",
		event_type: "im.message.receive_v1",
		sender: { sender_id, sender_type: "user" },
		message,
	};
}

describe("parseLarkInboundEventId", () => {
	it("returns the header event_id merged onto the payload", () => {
		expect(parseLarkInboundEventId(makeEvent({ eventId: "evt_abc" }))).toBe("evt_abc");
	});

	it("returns undefined when there is no event_id", () => {
		expect(parseLarkInboundEventId({ sender: {}, message: {} })).toBeUndefined();
		expect(parseLarkInboundEventId(null)).toBeUndefined();
		expect(parseLarkInboundEventId("nope")).toBeUndefined();
	});
});

describe("normalizeLarkInboundMessage — text", () => {
	it("extracts chat_id, sender open_id and text", () => {
		const result = normalizeLarkInboundMessage(
			makeEvent({ senderOpenId: "ou_sender", chatId: "oc_group", content: { text: "hello world" } }),
		);
		expect(result).toEqual({ channelKey: "oc_group", senderId: "ou_sender", text: "hello world", images: [] });
	});

	it("substitutes @_user_N mention placeholders with the mentioned name", () => {
		const result = normalizeLarkInboundMessage(
			makeEvent({
				content: { text: "@_user_1 please build it" },
				mentions: [{ key: "@_user_1", name: "Kanban Bot", id: { open_id: "ou_bot" } }],
			}),
		);
		expect(result?.text).toBe("@Kanban Bot please build it");
	});

	it("falls back to union_id then user_id for the sender when open_id is absent", () => {
		expect(normalizeLarkInboundMessage(makeEvent({ senderUnionId: "on_u" }))?.senderId).toBe("on_u");
		expect(normalizeLarkInboundMessage(makeEvent({ senderUserId: "usr_u" }))?.senderId).toBe("usr_u");
	});

	it("returns null for an empty text body (nothing to route)", () => {
		expect(normalizeLarkInboundMessage(makeEvent({ content: { text: "   " } }))).toBeNull();
	});
});

describe("normalizeLarkInboundMessage — image", () => {
	it("carries the image_key as a downloadable resource ref and empty text", () => {
		const result = normalizeLarkInboundMessage(
			makeEvent({ messageId: "om_img", messageType: "image", content: { image_key: "img_v2_key" } }),
		);
		expect(result).toEqual({
			channelKey: "oc_chat",
			senderId: "",
			text: "",
			images: [{ messageId: "om_img", fileKey: "img_v2_key" }],
		});
	});
});

describe("normalizeLarkInboundMessage — post (rich text)", () => {
	it("flattens title + text/link/at segments and collects embedded images", () => {
		const post = {
			title: "Proj",
			content: [
				[
					{ tag: "text", text: "Line1 " },
					{ tag: "a", text: "link", href: "https://x.test" },
					{ tag: "at", user_id: "ou_u", user_name: "Al" },
				],
				[
					{ tag: "img", image_key: "img_post_1" },
					{ tag: "text", text: "end" },
				],
			],
		};
		const result = normalizeLarkInboundMessage(
			makeEvent({ messageId: "om_post", messageType: "post", content: { post: { zh_cn: post } } }),
		);
		expect(result?.channelKey).toBe("oc_chat");
		expect(result?.text).toBe("Proj\nLine1 link@Al\nend");
		expect(result?.images).toEqual([{ messageId: "om_post", fileKey: "img_post_1" }]);
	});

	it("supports a locale-less post body (content is the segment matrix directly)", () => {
		const result = normalizeLarkInboundMessage(
			makeEvent({
				messageType: "post",
				content: { title: "", content: [[{ tag: "text", text: "just text" }]] },
			}),
		);
		expect(result?.text).toBe("just text");
	});
});

describe("normalizeLarkInboundMessage — skip conditions", () => {
	it("returns null for an unsupported message type with no text or images", () => {
		expect(normalizeLarkInboundMessage(makeEvent({ messageType: "audio", content: { file_key: "f" } }))).toBeNull();
	});

	it("returns null when chat_id is missing", () => {
		const evt = makeEvent({ content: { text: "hi" } }) as { message: Record<string, unknown> };
		delete evt.message.chat_id;
		expect(normalizeLarkInboundMessage(evt)).toBeNull();
	});

	it("returns null when content is not valid JSON", () => {
		expect(normalizeLarkInboundMessage(makeEvent({ content: "{not json" }))).toBeNull();
	});

	it("returns null for a non-object payload", () => {
		expect(normalizeLarkInboundMessage(null)).toBeNull();
		expect(normalizeLarkInboundMessage(42)).toBeNull();
	});
});
