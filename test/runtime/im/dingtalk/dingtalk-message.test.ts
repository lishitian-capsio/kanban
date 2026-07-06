import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ImOutboundCredential } from "../../../../src/im";
import {
	buildDingtalkCardPayload,
	buildDingtalkTextPayload,
	DINGTALK_DEFAULT_CARD_TITLE,
	DINGTALK_DEFAULT_ROBOT_ENDPOINT,
	resolveDingtalkWebhookUrl,
	signDingtalkWebhookUrl,
} from "../../../../src/im/dingtalk/dingtalk-message";

describe("buildDingtalkTextPayload", () => {
	it("wraps plain text in the DingTalk text msgtype", () => {
		expect(buildDingtalkTextPayload("hello world")).toEqual({
			msgtype: "text",
			text: { content: "hello world" },
		});
	});
});

describe("buildDingtalkCardPayload", () => {
	it("renders a card with no buttons as a markdown message", () => {
		expect(buildDingtalkCardPayload({ title: "Build done", text: "**all green**" })).toEqual({
			msgtype: "markdown",
			markdown: { title: "Build done", text: "**all green**" },
		});
	});

	it("falls back to the default title when the card omits one", () => {
		const payload = buildDingtalkCardPayload({ text: "body only" });
		expect(payload).toEqual({
			msgtype: "markdown",
			markdown: { title: DINGTALK_DEFAULT_CARD_TITLE, text: "body only" },
		});
	});

	it("renders a single-button card as an actionCard with singleTitle/singleURL", () => {
		const payload = buildDingtalkCardPayload({
			title: "Review",
			text: "PR ready",
			buttons: [{ text: "Open PR", url: "https://example.com/pr/1" }],
		});
		expect(payload).toEqual({
			msgtype: "actionCard",
			actionCard: {
				title: "Review",
				text: "PR ready",
				singleTitle: "Open PR",
				singleURL: "https://example.com/pr/1",
			},
		});
	});

	it("renders a multi-button card as an actionCard with a vertical btns array", () => {
		const payload = buildDingtalkCardPayload({
			title: "Choose",
			text: "pick one",
			buttons: [
				{ text: "Approve", url: "https://example.com/approve" },
				{ text: "Reject", url: "https://example.com/reject" },
			],
		});
		expect(payload).toEqual({
			msgtype: "actionCard",
			actionCard: {
				title: "Choose",
				text: "pick one",
				btnOrientation: "0",
				btns: [
					{ title: "Approve", actionURL: "https://example.com/approve" },
					{ title: "Reject", actionURL: "https://example.com/reject" },
				],
			},
		});
	});
});

describe("signDingtalkWebhookUrl", () => {
	it("appends the timestamp and the URL-encoded HMAC-SHA256 sign", () => {
		const secret = "SECsigningkey";
		const ts = 1_700_000_000_000;
		const base = "https://oapi.dingtalk.com/robot/send?access_token=tok123";

		const signed = signDingtalkWebhookUrl(base, secret, ts);

		const expectedSign = encodeURIComponent(
			createHmac("sha256", secret).update(`${ts}\n${secret}`).digest("base64"),
		);
		expect(signed).toBe(`${base}&timestamp=${ts}&sign=${expectedSign}`);
	});

	it("uses ? as the separator when the base URL has no query string", () => {
		const signed = signDingtalkWebhookUrl("https://oapi.dingtalk.com/robot/send", "s", 10);
		expect(signed.startsWith("https://oapi.dingtalk.com/robot/send?timestamp=10&sign=")).toBe(true);
	});
});

describe("resolveDingtalkWebhookUrl", () => {
	const withWebhook: ImOutboundCredential = {
		webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=embedded",
	};

	it("returns the credential webhookUrl unchanged when it already carries a token and no chatId overrides", () => {
		expect(resolveDingtalkWebhookUrl(withWebhook, "")).toBe(withWebhook.webhookUrl);
	});

	it("lets a non-empty chatId override the access_token on the webhookUrl", () => {
		const url = new URL(resolveDingtalkWebhookUrl(withWebhook, "grouptoken"));
		expect(url.searchParams.get("access_token")).toBe("grouptoken");
	});

	it("builds the default robot endpoint from botToken when no webhookUrl is set", () => {
		const url = new URL(resolveDingtalkWebhookUrl({ botToken: "bt-1" }, ""));
		expect(url.origin + url.pathname).toBe(DINGTALK_DEFAULT_ROBOT_ENDPOINT);
		expect(url.searchParams.get("access_token")).toBe("bt-1");
	});

	it("prefers the chatId token over the credential botToken", () => {
		const url = new URL(resolveDingtalkWebhookUrl({ botToken: "bt-1" }, "chat-tok"));
		expect(url.searchParams.get("access_token")).toBe("chat-tok");
	});

	it("throws when neither a webhookUrl token, a botToken, nor a chatId resolves an access_token", () => {
		expect(() => resolveDingtalkWebhookUrl({ webhookUrl: "https://oapi.dingtalk.com/robot/send" }, "")).toThrow();
	});
});
