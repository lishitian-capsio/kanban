/**
 * Core types for the IM (instant-messaging) outbound abstraction.
 *
 * This layer defines *what* an outbound IM message is and *where* it goes, decoupled from
 * any concrete platform (Lark / DingTalk / …). Concrete adapters are registered separately
 * (see {@link ./im-provider-registry}); nothing here talks to a network or a specific SDK.
 *
 * Background: requirement ac99c ("会话可绑定 IM 渠道") — a session can be bound to an IM
 * channel so outbound notifications can be delivered to it. An {@link ImChannelTarget} is that
 * binding descriptor: the platform plus the platform-native chat id.
 */
import { z } from "zod";

/**
 * The set of supported IM platforms, keyed by a stable platform id. New platforms are added
 * here first; the registry and credential store key off this id (mirrors the DB engine union
 * and the host-keyed git credential injector).
 */
export const IM_PLATFORMS = ["lark", "dingtalk"] as const;

/** Zod schema for {@link ImPlatform}, so on-disk / wire data can be validated. */
export const imPlatformSchema = z.enum(IM_PLATFORMS);

/** A supported IM platform id (`"lark" | "dingtalk"`). */
export type ImPlatform = z.infer<typeof imPlatformSchema>;

/**
 * A concrete delivery target: the platform plus its native chat identifier (Lark `chat_id` /
 * `open_id`, DingTalk conversation id, …). This doubles as the "channel binding" a session
 * stores when bound to an IM channel — see the `imChannel` field on a home chat thread
 * (`runtimeHomeChatThreadSchema`), which persists exactly this descriptor.
 *
 * A zod schema (not a bare interface) so on-disk / wire bindings can be validated; the type is
 * inferred from it to keep a single source of truth.
 */
export const imChannelTargetSchema = z.object({
	platform: imPlatformSchema,
	/** The platform-native chat / conversation identifier. */
	chatId: z.string().min(1),
});

/** A concrete delivery target / channel binding (see {@link imChannelTargetSchema}). */
export type ImChannelTarget = z.infer<typeof imChannelTargetSchema>;

/** A plain-text outbound message — the minimal payload for {@link ImProvider.sendMessage}. */
export interface ImTextMessage {
	text: string;
}

/** A single actionable button on a card (rendered as a link/action by the concrete adapter). */
export interface ImCardButton {
	text: string;
	url: string;
}

/**
 * A neutral, platform-agnostic rich "card" payload for {@link ImProvider.sendCard}. Concrete
 * adapters map this onto their platform-native interactive-card format (Lark interactive card,
 * DingTalk ActionCard, …). Kept intentionally small — title + body + optional action buttons —
 * so it stays portable across platforms.
 */
export interface ImCard {
	title?: string;
	text: string;
	buttons?: ImCardButton[];
}

/** The outcome of an outbound send. `messageId` is optional (webhook sends may not return one). */
export interface ImSendResult {
	platform: ImPlatform;
	chatId: string;
	/** Platform-assigned message id when the send API returns one. */
	messageId?: string;
}

/**
 * A single platform's outbound credential. Held ONLY in machine-local 0600 storage (see
 * {@link ./im-credential-store}) — never committed to git, never logged. At least one of
 * `botToken` (bot/app API) or `webhookUrl` (incoming-webhook robot) must be present.
 */
export const imOutboundCredentialSchema = z
	.object({
		/** Bot/app token used to authenticate against the platform's message API. */
		botToken: z.string().min(1).optional(),
		/** Incoming-webhook ("robot") URL for platforms that deliver via a signed webhook. */
		webhookUrl: z.string().min(1).optional(),
		/** Optional signing secret paired with a signed webhook (e.g. DingTalk). */
		webhookSecret: z.string().min(1).optional(),
	})
	.refine((c) => Boolean(c.botToken) || Boolean(c.webhookUrl), {
		message: "an IM outbound credential must set at least one of botToken or webhookUrl",
	});

/** A single platform's outbound credential (see {@link imOutboundCredentialSchema}). */
export type ImOutboundCredential = z.infer<typeof imOutboundCredentialSchema>;

/**
 * On-disk shape of the machine-local IM credential file: a map keyed by platform id. Extensible
 * by construction — adding a platform to {@link IM_PLATFORMS} extends this without a shape change.
 */
export const persistedImCredentialsSchema = z.record(imPlatformSchema, imOutboundCredentialSchema);

/** The full set of persisted per-platform outbound credentials. */
export type PersistedImCredentials = z.infer<typeof persistedImCredentialsSchema>;
