import { describe, expect, it } from "vitest";
import { DingtalkStreamCredentialFormatError } from "../../../../src/im/dingtalk/errors";
import {
	buildDingtalkAckFrame,
	buildDingtalkOpenRequest,
	decodeDingtalkBotMessage,
	decodeDingtalkCardAction,
	DINGTALK_BOT_MESSAGE_TOPIC,
	DINGTALK_CARD_CALLBACK_TOPIC,
	DINGTALK_SYSTEM_DISCONNECT_TOPIC,
	DINGTALK_SYSTEM_PING_TOPIC,
	isDingtalkBotMessageFrame,
	isDingtalkCardCallbackFrame,
	isDingtalkDisconnectFrame,
	isDingtalkPingFrame,
	parseDingtalkStreamCredential,
	parseDingtalkStreamFrame,
} from "../../../../src/im/dingtalk/dingtalk-stream-protocol";

describe("parseDingtalkStreamCredential", () => {
	it("splits appKey:appSecret on the first colon", () => {
		expect(parseDingtalkStreamCredential("ding_key:sec:ret")).toEqual({ appKey: "ding_key", appSecret: "sec:ret" });
	});

	it("trims surrounding whitespace on each half", () => {
		expect(parseDingtalkStreamCredential(" key : secret ")).toEqual({ appKey: "key", appSecret: "secret" });
	});

	it("throws when there is no colon", () => {
		expect(() => parseDingtalkStreamCredential("noseparator")).toThrow(DingtalkStreamCredentialFormatError);
	});

	it("throws when either half is blank", () => {
		expect(() => parseDingtalkStreamCredential(":secret")).toThrow(DingtalkStreamCredentialFormatError);
		expect(() => parseDingtalkStreamCredential("key:")).toThrow(DingtalkStreamCredentialFormatError);
	});
});

describe("buildDingtalkOpenRequest", () => {
	it("carries the credential as clientId/clientSecret and subscribes to bot messages", () => {
		const request = buildDingtalkOpenRequest({ appKey: "ak", appSecret: "as" });
		expect(request.clientId).toBe("ak");
		expect(request.clientSecret).toBe("as");
		expect(request.subscriptions).toContainEqual({ type: "CALLBACK", topic: DINGTALK_BOT_MESSAGE_TOPIC });
		expect(request.ua).toBeTruthy();
		expect(request.localIp).toBeTruthy();
	});

	it("also subscribes to the interactive-card callback topic", () => {
		const request = buildDingtalkOpenRequest({ appKey: "ak", appSecret: "as" });
		expect(request.subscriptions).toContainEqual({ type: "CALLBACK", topic: DINGTALK_CARD_CALLBACK_TOPIC });
	});
});

describe("parseDingtalkStreamFrame", () => {
	it("extracts type, topic and messageId from the frame headers", () => {
		const raw = JSON.stringify({
			specVersion: "1.0",
			type: "CALLBACK",
			headers: { topic: DINGTALK_BOT_MESSAGE_TOPIC, messageId: "msg-1", contentType: "application/json" },
			data: '{"hello":"world"}',
		});
		expect(parseDingtalkStreamFrame(raw)).toEqual({
			type: "CALLBACK",
			topic: DINGTALK_BOT_MESSAGE_TOPIC,
			messageId: "msg-1",
			data: '{"hello":"world"}',
		});
	});

	it("returns null for non-JSON input", () => {
		expect(parseDingtalkStreamFrame("not json")).toBeNull();
	});

	it("returns null when required fields are missing", () => {
		expect(parseDingtalkStreamFrame(JSON.stringify({ type: "CALLBACK" }))).toBeNull();
		expect(parseDingtalkStreamFrame(JSON.stringify({ headers: { topic: "x", messageId: "y" } }))).toBeNull();
	});
});

describe("frame classification", () => {
	function frame(type: string, topic: string) {
		return { type, topic, messageId: "m", data: "{}" };
	}

	it("recognizes SYSTEM ping frames", () => {
		expect(isDingtalkPingFrame(frame("SYSTEM", DINGTALK_SYSTEM_PING_TOPIC))).toBe(true);
		expect(isDingtalkPingFrame(frame("CALLBACK", DINGTALK_SYSTEM_PING_TOPIC))).toBe(false);
	});

	it("recognizes SYSTEM disconnect frames", () => {
		expect(isDingtalkDisconnectFrame(frame("SYSTEM", DINGTALK_SYSTEM_DISCONNECT_TOPIC))).toBe(true);
	});

	it("recognizes bot message frames", () => {
		expect(isDingtalkBotMessageFrame(frame("CALLBACK", DINGTALK_BOT_MESSAGE_TOPIC))).toBe(true);
		expect(isDingtalkBotMessageFrame(frame("SYSTEM", DINGTALK_SYSTEM_PING_TOPIC))).toBe(false);
	});

	it("recognizes card callback frames", () => {
		expect(isDingtalkCardCallbackFrame(frame("CALLBACK", DINGTALK_CARD_CALLBACK_TOPIC))).toBe(true);
		expect(isDingtalkCardCallbackFrame(frame("CALLBACK", DINGTALK_BOT_MESSAGE_TOPIC))).toBe(false);
	});
});

describe("buildDingtalkAckFrame", () => {
	it("wraps a 200 ack echoing the messageId", () => {
		const parsed = JSON.parse(buildDingtalkAckFrame("msg-42"));
		expect(parsed.code).toBe(200);
		expect(parsed.headers.messageId).toBe("msg-42");
		expect(parsed.headers.contentType).toBe("application/json");
		expect(parsed.data).toBe("{}");
	});

	it("echoes the provided data payload (used for ping responses)", () => {
		const parsed = JSON.parse(buildDingtalkAckFrame("ping-1", '{"a":1}'));
		expect(parsed.data).toBe('{"a":1}');
	});
});

describe("decodeDingtalkBotMessage", () => {
	it("maps a group text message to a normalized inbound event", () => {
		const data = JSON.stringify({
			conversationId: "cidGroup",
			conversationType: "2",
			senderId: "sender-long-id",
			senderStaffId: "staff-1",
			senderNick: "Alice",
			msgtype: "text",
			text: { content: "hello team" },
			msgId: "mid-1",
		});
		expect(decodeDingtalkBotMessage(data)).toEqual({
			dedupKey: "mid-1",
			event: {
				kind: "message",
				platform: "dingtalk",
				channelKey: "cidGroup",
				text: "hello team",
				senderId: "staff-1",
			},
		});
	});

	it("maps a single-chat text message the same way", () => {
		const data = JSON.stringify({
			conversationId: "cidP2P",
			conversationType: "1",
			senderId: "sender-long-id",
			msgtype: "text",
			text: { content: "hi" },
			msgId: "mid-2",
		});
		const decoded = decodeDingtalkBotMessage(data);
		expect(decoded?.event.channelKey).toBe("cidP2P");
		expect(decoded?.event.senderId).toBe("sender-long-id");
		expect(decoded?.event.text).toBe("hi");
	});

	it("flattens a richText message into its concatenated text segments", () => {
		const data = JSON.stringify({
			conversationId: "cid",
			senderId: "s",
			msgtype: "richText",
			content: { richText: [{ text: "part one " }, { type: "picture" }, { text: "part two" }] },
			msgId: "mid-3",
		});
		expect(decodeDingtalkBotMessage(data)?.event.text).toBe("part one part two");
	});

	it("falls back to msgId being absent by returning an empty dedupKey", () => {
		const data = JSON.stringify({
			conversationId: "cid",
			senderId: "s",
			msgtype: "text",
			text: { content: "no id" },
		});
		expect(decodeDingtalkBotMessage(data)?.dedupKey).toBe("");
	});

	it("returns null for unsupported message types (e.g. picture-only)", () => {
		const data = JSON.stringify({ conversationId: "cid", senderId: "s", msgtype: "picture", msgId: "mid-4" });
		expect(decodeDingtalkBotMessage(data)).toBeNull();
	});

	it("returns null when the conversation id or sender is missing", () => {
		expect(decodeDingtalkBotMessage(JSON.stringify({ senderId: "s", msgtype: "text", text: { content: "x" } }))).toBeNull();
		expect(
			decodeDingtalkBotMessage(JSON.stringify({ conversationId: "c", msgtype: "text", text: { content: "x" } })),
		).toBeNull();
	});

	it("returns null for non-JSON data", () => {
		expect(decodeDingtalkBotMessage("not json")).toBeNull();
	});

	it("returns null for a text message with an empty body", () => {
		const data = JSON.stringify({ conversationId: "c", senderId: "s", msgtype: "text", text: { content: "   " }, msgId: "m" });
		expect(decodeDingtalkBotMessage(data)).toBeNull();
	});
});

describe("decodeDingtalkCardAction", () => {
	function cardData(overrides: {
		outTrackId?: string | null;
		userId?: string | null;
		conversationId?: string;
		content?: unknown;
	}): string {
		const payload: Record<string, unknown> = {};
		if (overrides.outTrackId !== null) payload.outTrackId = overrides.outTrackId ?? "card-instance-1";
		if (overrides.userId !== null) payload.userId = overrides.userId ?? "staff-1";
		if (overrides.conversationId !== undefined) payload.conversationId = overrides.conversationId;
		payload.content =
			overrides.content !== undefined
				? overrides.content
				: JSON.stringify({ cardPrivateData: { params: { command: "merge" } } });
		return JSON.stringify(payload);
	}

	it("maps a card callback to a normalized card_action event", () => {
		const decoded = decodeDingtalkCardAction(
			cardData({
				outTrackId: "otid-1",
				userId: "staff-9",
				conversationId: "cidGroup",
				content: JSON.stringify({ cardPrivateData: { params: { command: "merge", taskId: "t1" } } }),
			}),
		);
		expect(decoded?.event).toEqual({
			kind: "card_action",
			platform: "dingtalk",
			channelKey: "cidGroup",
			senderId: "staff-9",
			action: { value: { command: "merge", taskId: "t1" } },
			callbackToken: "otid-1",
			cardRef: "otid-1",
		});
		expect(decoded?.dedupKey).toContain("otid-1");
	});

	it("produces a stable dedupKey per interaction and distinct keys for distinct button values", () => {
		const a1 = decodeDingtalkCardAction(cardData({ content: JSON.stringify({ cardPrivateData: { params: { b: "1" } } }) }));
		const a2 = decodeDingtalkCardAction(cardData({ content: JSON.stringify({ cardPrivateData: { params: { b: "1" } } }) }));
		const b = decodeDingtalkCardAction(cardData({ content: JSON.stringify({ cardPrivateData: { params: { b: "2" } } }) }));
		expect(a1?.dedupKey).toBe(a2?.dedupKey);
		expect(a1?.dedupKey).not.toBe(b?.dedupKey);
	});

	it("falls back to the whole parsed content when it carries no cardPrivateData.params wrapper", () => {
		const decoded = decodeDingtalkCardAction(cardData({ content: JSON.stringify({ command: "reject" }) }));
		expect(decoded?.event.action.value).toEqual({ command: "reject" });
	});

	it("stays deliverable with an empty value when content is unparseable", () => {
		const decoded = decodeDingtalkCardAction(cardData({ content: "not json" }));
		expect(decoded?.event.action.value).toEqual({});
		expect(decoded?.event.callbackToken).toBe("card-instance-1");
	});

	it("leaves channelKey empty when the callback omits a conversationId", () => {
		expect(decodeDingtalkCardAction(cardData({}))?.event.channelKey).toBe("");
	});

	it("returns null when the operator userId is missing", () => {
		expect(decodeDingtalkCardAction(cardData({ userId: null }))).toBeNull();
	});

	it("returns null when the outTrackId is missing", () => {
		expect(decodeDingtalkCardAction(cardData({ outTrackId: null }))).toBeNull();
	});

	it("returns null for non-JSON data", () => {
		expect(decodeDingtalkCardAction("not json")).toBeNull();
	});
});
