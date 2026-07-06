/**
 * Pure (network-free) mappers between the platform-agnostic IM payloads ({@link ImCard} /
 * {@link ImTextMessage}) and Lark's native `im/v1/messages` request shapes. Kept separate from
 * the provider so every mapping decision is unit-testable without a transport or credentials.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 */
import { LarkCredentialFormatError } from "./errors";
import type { ImCard } from "../types";

/**
 * Lark `receive_id_type` values relevant to sending to a group or a single user. The API also
 * accepts `user_id`, but Kanban's {@link ImChannelTarget} only carries an opaque `chatId`, so we
 * infer the type from the id's well-known prefix (see {@link inferLarkReceiveIdType}).
 */
export type LarkReceiveIdType = "chat_id" | "open_id" | "union_id" | "email";

/**
 * A Lark bot/app credential parsed out of the opaque {@link ImOutboundCredential.botToken}. Lark's
 * message API is authenticated with a short-lived `tenant_access_token`, which is itself minted
 * from an app's `app_id` + `app_secret` — so for Lark the single `botToken` field encodes both,
 * colon-joined as `"<app_id>:<app_secret>"`.
 */
export interface LarkBotCredential {
	appId: string;
	appSecret: string;
}

/**
 * Parse `"<app_id>:<app_secret>"` out of the stored {@link ImOutboundCredential.botToken}. The
 * split is on the FIRST colon only, so a secret that itself contains a colon survives intact.
 * Throws {@link LarkCredentialFormatError} when either half is missing/blank.
 */
export function parseLarkBotCredential(botToken: string): LarkBotCredential {
	const separator = botToken.indexOf(":");
	if (separator <= 0) {
		throw new LarkCredentialFormatError();
	}
	const appId = botToken.slice(0, separator).trim();
	const appSecret = botToken.slice(separator + 1).trim();
	if (!appId || !appSecret) {
		throw new LarkCredentialFormatError();
	}
	return { appId, appSecret };
}

/**
 * Infer Lark's `receive_id_type` from the target's opaque chat id by its documented prefix:
 * chat (`oc_`) → group, open id (`ou_`) → single chat, union id (`on_`); an `@` implies an email.
 * Unknown shapes default to `chat_id` (the "send to a group" case the requirement centers on).
 */
export function inferLarkReceiveIdType(chatId: string): LarkReceiveIdType {
	if (chatId.startsWith("ou_")) return "open_id";
	if (chatId.startsWith("on_")) return "union_id";
	if (chatId.startsWith("oc_")) return "chat_id";
	if (chatId.includes("@")) return "email";
	return "chat_id";
}

/**
 * Build the `content` string for a `msg_type: "text"` message. Lark expects `content` to be a
 * JSON-encoded STRING (not an object), so this returns `JSON.stringify({ text })`.
 */
export function buildLarkTextMessageContent(text: string): string {
	return JSON.stringify({ text });
}

/**
 * Map a neutral {@link ImCard} onto a Lark interactive-card `content` string (`msg_type:
 * "interactive"`). Header is emitted only when a title is present; an action block only when there
 * are buttons. Body text is sent as `lark_md` so simple markdown renders. Returns the
 * JSON-encoded STRING the API expects for `content`.
 */
export function buildLarkInteractiveCardContent(card: ImCard): string {
	const elements: unknown[] = [];
	if (card.text) {
		elements.push({ tag: "div", text: { tag: "lark_md", content: card.text } });
	}
	if (card.buttons && card.buttons.length > 0) {
		elements.push({
			tag: "action",
			actions: card.buttons.map((button) => ({
				tag: "button",
				text: { tag: "plain_text", content: button.text },
				url: button.url,
				type: "default",
			})),
		});
	}
	const content: Record<string, unknown> = {
		config: { wide_screen_mode: true },
		elements,
	};
	if (card.title) {
		content.header = { template: "blue", title: { tag: "plain_text", content: card.title } };
	}
	return JSON.stringify(content);
}
