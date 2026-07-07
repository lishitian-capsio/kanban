/**
 * Lark outbound {@link ImProvider} adapter — sends plain-text messages and interactive cards to a
 * Lark group or single chat, authenticated as the **bot/app** (the `im:message` send scope).
 *
 * Auth model: Lark's `im/v1/messages` API is called with a short-lived `tenant_access_token`,
 * minted from the app's `app_id` + `app_secret`. Those two secrets are stored — colon-joined as
 * `"<app_id>:<app_secret>"` — in the single opaque `botToken` field of the machine-local (0600)
 * IM credential store (see `../im-credential-store`), so nothing here takes a secret through the
 * public interface and nothing is ever committed or logged. The minted token is cached in memory
 * until shortly before its expiry.
 *
 * The transport, credential resolver and clock are all injectable so the whole adapter is
 * unit-testable against a fake transport with no real network. Every collaborator has a
 * production default (global `fetch`, {@link resolveImCredential}, `Date.now`).
 *
 * These methods THROW on failure (the honest contract for `Promise<ImSendResult>`). The
 * runtime-safe "log-and-swallow, never drag down the runtime" behavior lives one layer up in the
 * outbound dispatch seam (`../im-dispatch`), which is the entry point the runtime actually calls.
 */
import { createLogger } from "../../logging";
import { resolveImCredential } from "../im-credential-store";
import type { ImProvider } from "../im-provider";
import { registerImProvider } from "../im-provider-registry";
import type { ImCard, ImChannelTarget, ImOutboundCredential, ImPlatform, ImSendResult, ImTextMessage } from "../types";
import { buildLarkChatInfoUrl, buildLarkUserInfoUrl, DEFAULT_LARK_BASE_URL } from "./lark-endpoints";
import { isRecord, type LarkFetch, larkGetJson, larkPostJson } from "./lark-http";
import {
	buildLarkInteractiveCardContent,
	buildLarkTextMessageContent,
	inferLarkReceiveIdType,
} from "./lark-message-format";
import { DEFAULT_TOKEN_SAFETY_WINDOW_MS, LarkTenantTokenProvider } from "./lark-tenant-token";

const log = createLogger("im.lark");

/** Per-request timeout for Lark OpenAPI calls. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type { LarkFetch } from "./lark-http";

export interface LarkImProviderOptions {
	/** Transport. Defaults to the global `fetch` (which the runtime's proxy interceptor wraps). */
	fetchImpl?: LarkFetch;
	/** OpenAPI base URL. Defaults to {@link DEFAULT_LARK_BASE_URL}. */
	baseUrl?: string;
	/** Resolve the Lark outbound credential. Defaults to the machine-local 0600 store. */
	resolveCredential?: () => Promise<ImOutboundCredential | null>;
	/** Monotonic-ish clock, injected for deterministic token-expiry tests. Defaults to `Date.now`. */
	now?: () => number;
	requestTimeoutMs?: number;
	tokenSafetyWindowMs?: number;
}

export class LarkImProvider implements ImProvider {
	readonly platform: ImPlatform = "lark";

	private readonly fetchImpl: LarkFetch;
	private readonly baseUrl: string;
	private readonly requestTimeoutMs: number;
	private readonly tokenProvider: LarkTenantTokenProvider;

	constructor(options: LarkImProviderOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		this.baseUrl = (options.baseUrl ?? DEFAULT_LARK_BASE_URL).replace(/\/+$/, "");
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.tokenProvider = new LarkTenantTokenProvider({
			fetchImpl: this.fetchImpl,
			baseUrl: this.baseUrl,
			resolveCredential: options.resolveCredential ?? (() => resolveImCredential("lark")),
			now: options.now,
			requestTimeoutMs: this.requestTimeoutMs,
			tokenSafetyWindowMs: options.tokenSafetyWindowMs ?? DEFAULT_TOKEN_SAFETY_WINDOW_MS,
		});
	}

	async sendMessage(target: ImChannelTarget, message: ImTextMessage): Promise<ImSendResult> {
		return this.send(target, "text", buildLarkTextMessageContent(message.text));
	}

	async sendCard(target: ImChannelTarget, card: ImCard): Promise<ImSendResult> {
		return this.send(target, "interactive", buildLarkInteractiveCardContent(card));
	}

	/**
	 * Best-effort human-readable name for a Lark chat. A group (`oc_`) resolves via
	 * `im/v1/chats/{chat_id}` → `data.name`; a single chat (`ou_`/`on_`) resolves the peer's name
	 * via `contact/v3/users/{user_id}` → `data.user.name`. An email target or any failure (missing
	 * scope, network, unknown id) resolves to `null` so the caller falls back to the raw id.
	 */
	async resolveChatName(target: ImChannelTarget): Promise<string | null> {
		const receiveIdType = inferLarkReceiveIdType(target.chatId);
		try {
			if (receiveIdType === "chat_id") {
				return await this.fetchChatName(target.chatId);
			}
			if (receiveIdType === "open_id" || receiveIdType === "union_id") {
				return await this.fetchUserName(target.chatId, receiveIdType);
			}
			// An email target has no name-lookup path here; fall back to the id.
			return null;
		} catch (error) {
			// Never throw for the unresolvable case — degrade to the raw id (the interface contract).
			log.debug("failed to resolve lark chat name", {
				platform: this.platform,
				error,
			});
			return null;
		}
	}

	/** GET a group chat's title. Returns the trimmed name, or `null` when the API omits one. */
	private async fetchChatName(chatId: string): Promise<string | null> {
		const token = await this.tokenProvider.getToken();
		const body = await larkGetJson(this.fetchImpl, buildLarkChatInfoUrl(this.baseUrl, chatId), {
			headers: { Authorization: `Bearer ${token}` },
			timeoutMs: this.requestTimeoutMs,
		});
		const data = isRecord(body.data) ? body.data : {};
		const name = typeof data.name === "string" ? data.name.trim() : "";
		return name.length > 0 ? name : null;
	}

	/** GET a single chat's peer display name via the contact API. */
	private async fetchUserName(userId: string, userIdType: "open_id" | "union_id"): Promise<string | null> {
		const token = await this.tokenProvider.getToken();
		const body = await larkGetJson(this.fetchImpl, buildLarkUserInfoUrl(this.baseUrl, userId, userIdType), {
			headers: { Authorization: `Bearer ${token}` },
			timeoutMs: this.requestTimeoutMs,
		});
		const data = isRecord(body.data) ? body.data : {};
		const user = isRecord(data.user) ? data.user : {};
		const name = typeof user.name === "string" ? user.name.trim() : "";
		return name.length > 0 ? name : null;
	}

	/** POST a single message to the target chat, resolving/minting the bot token as needed. */
	private async send(target: ImChannelTarget, msgType: string, content: string): Promise<ImSendResult> {
		const token = await this.tokenProvider.getToken();
		const receiveIdType = inferLarkReceiveIdType(target.chatId);
		const url = `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;
		const body = await larkPostJson(
			this.fetchImpl,
			url,
			{ receive_id: target.chatId, msg_type: msgType, content },
			{ headers: { Authorization: `Bearer ${token}` }, timeoutMs: this.requestTimeoutMs },
		);
		const data = isRecord(body.data) ? body.data : {};
		const messageId = typeof data.message_id === "string" ? data.message_id : undefined;
		return { platform: this.platform, chatId: target.chatId, ...(messageId ? { messageId } : {}) };
	}
}

/**
 * Construct a {@link LarkImProvider} and register it in the platform-keyed registry. Registration
 * is side-effect-free w.r.t. credentials (they're resolved lazily per send), so it is safe to call
 * unconditionally at startup — the adapter is simply dormant until a `lark` credential is stored.
 */
export function registerLarkImProvider(options?: LarkImProviderOptions): LarkImProvider {
	const provider = new LarkImProvider(options);
	registerImProvider(provider);
	log.debug("registered lark im provider");
	return provider;
}
