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
import { ImCredentialUnavailableError } from "../errors";
import { resolveImCredential } from "../im-credential-store";
import type { ImProvider } from "../im-provider";
import { registerImProvider } from "../im-provider-registry";
import type { ImCard, ImChannelTarget, ImOutboundCredential, ImPlatform, ImSendResult, ImTextMessage } from "../types";
import { LarkApiError } from "./errors";
import {
	buildLarkInteractiveCardContent,
	buildLarkTextMessageContent,
	inferLarkReceiveIdType,
	parseLarkBotCredential,
} from "./lark-message-format";

const log = createLogger("im.lark");

/** Default Lark OpenAPI base (feishu.cn). Override for lark.com global via {@link LarkImProviderOptions.baseUrl}. */
const DEFAULT_LARK_BASE_URL = "https://open.feishu.cn";

/** Refresh the tenant token this many ms before its stated expiry, to avoid using an expired one. */
const DEFAULT_TOKEN_SAFETY_WINDOW_MS = 60_000;

/** Fallback tenant-token lifetime (ms) when the mint response omits `expire`. Lark's default is 2h. */
const FALLBACK_TOKEN_TTL_MS = 7_200_000;

/** Per-request timeout for Lark OpenAPI calls. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** The minimal `fetch` surface this adapter needs — satisfied by global `fetch` and test fakes. */
export type LarkFetch = (url: string, init: RequestInit) => Promise<Response>;

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

interface CachedTenantToken {
	token: string;
	/** Epoch ms after which the token must be re-minted (already includes the safety window). */
	expiresAtMs: number;
}

export class LarkImProvider implements ImProvider {
	readonly platform: ImPlatform = "lark";

	private readonly fetchImpl: LarkFetch;
	private readonly baseUrl: string;
	private readonly resolveCredential: () => Promise<ImOutboundCredential | null>;
	private readonly now: () => number;
	private readonly requestTimeoutMs: number;
	private readonly tokenSafetyWindowMs: number;
	private cachedToken: CachedTenantToken | null = null;

	constructor(options: LarkImProviderOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		this.baseUrl = (options.baseUrl ?? DEFAULT_LARK_BASE_URL).replace(/\/+$/, "");
		this.resolveCredential = options.resolveCredential ?? (() => resolveImCredential("lark"));
		this.now = options.now ?? (() => Date.now());
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.tokenSafetyWindowMs = options.tokenSafetyWindowMs ?? DEFAULT_TOKEN_SAFETY_WINDOW_MS;
	}

	async sendMessage(target: ImChannelTarget, message: ImTextMessage): Promise<ImSendResult> {
		return this.send(target, "text", buildLarkTextMessageContent(message.text));
	}

	async sendCard(target: ImChannelTarget, card: ImCard): Promise<ImSendResult> {
		return this.send(target, "interactive", buildLarkInteractiveCardContent(card));
	}

	/** POST a single message to the target chat, resolving/minting the bot token as needed. */
	private async send(target: ImChannelTarget, msgType: string, content: string): Promise<ImSendResult> {
		const token = await this.getTenantAccessToken();
		const receiveIdType = inferLarkReceiveIdType(target.chatId);
		const url = `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;
		const body = await this.postJson(
			url,
			{ receive_id: target.chatId, msg_type: msgType, content },
			{ Authorization: `Bearer ${token}` },
		);
		const data = isRecord(body.data) ? body.data : {};
		const messageId = typeof data.message_id === "string" ? data.message_id : undefined;
		return { platform: this.platform, chatId: target.chatId, ...(messageId ? { messageId } : {}) };
	}

	/** Return a valid cached tenant token or mint (and cache) a fresh one. */
	private async getTenantAccessToken(): Promise<string> {
		const cached = this.cachedToken;
		if (cached && this.now() < cached.expiresAtMs) {
			return cached.token;
		}
		const credential = await this.resolveCredential();
		if (!credential?.botToken) {
			// Bot identity requires an app credential; a webhook-only credential can't call this API.
			throw new ImCredentialUnavailableError("lark");
		}
		const { appId, appSecret } = parseLarkBotCredential(credential.botToken);
		const body = await this.postJson(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
			app_id: appId,
			app_secret: appSecret,
		});
		const token = typeof body.tenant_access_token === "string" ? body.tenant_access_token : "";
		if (!token) {
			throw new LarkApiError("lark tenant_access_token response missing token", 0);
		}
		const expireSeconds = typeof body.expire === "number" && Number.isFinite(body.expire) ? body.expire : null;
		const ttlMs = expireSeconds !== null ? expireSeconds * 1000 : FALLBACK_TOKEN_TTL_MS;
		this.cachedToken = { token, expiresAtMs: this.now() + Math.max(0, ttlMs - this.tokenSafetyWindowMs) };
		return token;
	}

	/**
	 * POST a JSON body to a Lark endpoint and return the parsed JSON object. Throws
	 * {@link LarkApiError} on a non-2xx status or a non-zero business `code`. Never logs the
	 * request body (may contain message content) or the auth header.
	 */
	private async postJson(
		url: string,
		payload: Record<string, unknown>,
		extraHeaders: Record<string, string> = {},
	): Promise<Record<string, unknown>> {
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === "TimeoutError") {
				throw new LarkApiError(`lark request to ${url} timed out after ${this.requestTimeoutMs}ms`, 0);
			}
			throw new LarkApiError(`lark request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`, 0);
		}
		if (!response.ok) {
			throw new LarkApiError(`lark request failed with HTTP ${response.status}`, response.status);
		}
		const parsed = (await response.json().catch(() => null)) as unknown;
		if (!isRecord(parsed)) {
			throw new LarkApiError("lark returned a non-object response body", 0);
		}
		const code = typeof parsed.code === "number" ? parsed.code : 0;
		if (code !== 0) {
			const msg = typeof parsed.msg === "string" ? parsed.msg : "unknown error";
			throw new LarkApiError(`lark API error ${code}: ${msg}`, code);
		}
		return parsed;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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
