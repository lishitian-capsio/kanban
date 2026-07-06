/**
 * Pure payload + URL helpers for the DingTalk outbound adapter — no network, no I/O, no clock of
 * their own (the caller injects the timestamp). Kept separate from the provider so the payload
 * mapping and the webhook signing are unit-testable in isolation.
 *
 * DingTalk delivery model (see `dingtalk-provider.ts` for the rationale): the adapter posts to a
 * **custom robot ("自定义机器人") webhook** identified by an `access_token`. The webhook itself
 * pins the target group, so multi-group targeting is expressed by swapping the `access_token`
 * (the {@link ImChannelTarget.chatId}) on a shared endpoint. Optional HMAC-SHA256 signing
 * (`timestamp` + `sign`) is applied when the credential carries a `webhookSecret`.
 */
import { createHmac } from "node:crypto";

import { ImError } from "../errors";
import type { ImCard, ImOutboundCredential } from "../types";

/** Default DingTalk custom-robot endpoint, used when the credential stores only a token. */
export const DINGTALK_DEFAULT_ROBOT_ENDPOINT = "https://oapi.dingtalk.com/robot/send";

/** Title shown for a card that omits one (DingTalk markdown/actionCard require a non-empty title). */
export const DINGTALK_DEFAULT_CARD_TITLE = "通知";

/** DingTalk `text` message payload. */
export interface DingtalkTextPayload {
	msgtype: "text";
	text: { content: string };
}

/** DingTalk `markdown` message payload (used for a button-less card). */
export interface DingtalkMarkdownPayload {
	msgtype: "markdown";
	markdown: { title: string; text: string };
}

/** DingTalk `actionCard` payload (used for a card with one or more buttons). */
export interface DingtalkActionCardPayload {
	msgtype: "actionCard";
	actionCard: {
		title: string;
		text: string;
		/** "0" = buttons stacked vertically, "1" = side by side. Only set for the multi-button form. */
		btnOrientation?: "0" | "1";
		/** Single-button form. */
		singleTitle?: string;
		singleURL?: string;
		/** Multi-button form. */
		btns?: { title: string; actionURL: string }[];
	};
}

/** Any outbound payload the adapter can post to the robot webhook. */
export type DingtalkOutboundPayload = DingtalkTextPayload | DingtalkMarkdownPayload | DingtalkActionCardPayload;

/** Wrap plain text in the DingTalk `text` msgtype. */
export function buildDingtalkTextPayload(text: string): DingtalkTextPayload {
	return { msgtype: "text", text: { content: text } };
}

/**
 * Map the platform-neutral {@link ImCard} onto a DingTalk payload:
 *  - no buttons ⇒ a `markdown` message (title + body);
 *  - exactly one button ⇒ an `actionCard` with `singleTitle`/`singleURL`;
 *  - two or more buttons ⇒ an `actionCard` with a vertical `btns` array.
 */
export function buildDingtalkCardPayload(card: ImCard): DingtalkMarkdownPayload | DingtalkActionCardPayload {
	const title = card.title?.trim() || DINGTALK_DEFAULT_CARD_TITLE;
	const buttons = card.buttons ?? [];

	if (buttons.length === 0) {
		return { msgtype: "markdown", markdown: { title, text: card.text } };
	}

	if (buttons.length === 1) {
		return {
			msgtype: "actionCard",
			actionCard: { title, text: card.text, singleTitle: buttons[0].text, singleURL: buttons[0].url },
		};
	}

	return {
		msgtype: "actionCard",
		actionCard: {
			title,
			text: card.text,
			btnOrientation: "0",
			btns: buttons.map((b) => ({ title: b.text, actionURL: b.url })),
		},
	};
}

/**
 * Append the DingTalk signed-webhook query params (`timestamp` + `sign`). The signature is
 * `base64(HMAC_SHA256("<timestamp>\n<secret>", secret))`, URL-encoded. The timestamp is supplied
 * by the caller (injected clock) so the signing stays pure/testable.
 */
export function signDingtalkWebhookUrl(url: string, secret: string, timestampMs: number): string {
	const sign = createHmac("sha256", secret).update(`${timestampMs}\n${secret}`).digest("base64");
	const separator = url.includes("?") ? "&" : "?";
	return `${url}${separator}timestamp=${timestampMs}&sign=${encodeURIComponent(sign)}`;
}

/**
 * Resolve the (unsigned) robot webhook URL for a target. The robot `access_token` is resolved
 * with precedence `chatId` → credential `botToken` → the token already embedded in the credential
 * `webhookUrl`; the endpoint base is the credential `webhookUrl` (query preserved) or the default
 * robot endpoint. Throws {@link ImError} when no `access_token` can be resolved.
 */
export function resolveDingtalkWebhookUrl(credential: ImOutboundCredential, chatId: string): string {
	const overrideToken = chatId.trim() || credential.botToken?.trim() || "";
	const base = credential.webhookUrl?.trim();

	const url = new URL(base || DINGTALK_DEFAULT_ROBOT_ENDPOINT);
	if (overrideToken) {
		url.searchParams.set("access_token", overrideToken);
	}
	if (!url.searchParams.get("access_token")) {
		throw new ImError(
			"DingTalk outbound has no access_token: set a chatId, a botToken, or an access_token in the webhookUrl",
		);
	}
	return url.toString();
}
