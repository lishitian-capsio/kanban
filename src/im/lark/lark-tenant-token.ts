/**
 * Mints and in-memory-caches a Lark `tenant_access_token` — the short-lived bearer the message API
 * (`im/v1/messages`, message resource download, …) is authenticated with. The token is derived from
 * an app's `app_id` + `app_secret`, which are stored colon-joined in the opaque `botToken` field of
 * the machine-local (0600) IM credential store (see `../im-credential-store`), so no secret is ever
 * taken through a public interface, committed, or logged.
 *
 * Shared by the outbound provider (`./lark-provider`) and the inbound connector's image download
 * (`./lark-inbound-connector`) so token lifecycle lives in exactly one place. The transport,
 * credential resolver and clock are injectable for deterministic tests.
 */
import { ImCredentialUnavailableError } from "../errors";
import type { ImOutboundCredential } from "../types";
import { LarkApiError } from "./errors";
import { type LarkFetch, larkPostJson } from "./lark-http";
import { parseLarkBotCredential } from "./lark-message-format";

/** Refresh the tenant token this many ms before its stated expiry, to avoid using an expired one. */
export const DEFAULT_TOKEN_SAFETY_WINDOW_MS = 60_000;

/** Fallback tenant-token lifetime (ms) when the mint response omits `expire`. Lark's default is 2h. */
export const FALLBACK_TOKEN_TTL_MS = 7_200_000;

export interface LarkTenantTokenOptions {
	/** Transport for the mint call. */
	fetchImpl: LarkFetch;
	/** OpenAPI base URL with no trailing slash (e.g. `https://open.feishu.cn`). */
	baseUrl: string;
	/** Resolve the Lark outbound credential (its `botToken` carries `app_id:app_secret`). */
	resolveCredential: () => Promise<ImOutboundCredential | null>;
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

export class LarkTenantTokenProvider {
	private readonly fetchImpl: LarkFetch;
	private readonly baseUrl: string;
	private readonly resolveCredential: () => Promise<ImOutboundCredential | null>;
	private readonly now: () => number;
	private readonly requestTimeoutMs?: number;
	private readonly tokenSafetyWindowMs: number;
	private cached: CachedTenantToken | null = null;

	constructor(options: LarkTenantTokenOptions) {
		this.fetchImpl = options.fetchImpl;
		this.baseUrl = options.baseUrl;
		this.resolveCredential = options.resolveCredential;
		this.now = options.now ?? (() => Date.now());
		this.requestTimeoutMs = options.requestTimeoutMs;
		this.tokenSafetyWindowMs = options.tokenSafetyWindowMs ?? DEFAULT_TOKEN_SAFETY_WINDOW_MS;
	}

	/** Return a valid cached tenant token or mint (and cache) a fresh one. */
	async getToken(): Promise<string> {
		const cached = this.cached;
		if (cached && this.now() < cached.expiresAtMs) {
			return cached.token;
		}
		const credential = await this.resolveCredential();
		if (!credential?.botToken) {
			// Bot identity requires an app credential; a webhook-only credential can't call this API.
			throw new ImCredentialUnavailableError("lark");
		}
		const { appId, appSecret } = parseLarkBotCredential(credential.botToken);
		const body = await larkPostJson(
			this.fetchImpl,
			`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
			{ app_id: appId, app_secret: appSecret },
			{ timeoutMs: this.requestTimeoutMs },
		);
		const token = typeof body.tenant_access_token === "string" ? body.tenant_access_token : "";
		if (!token) {
			throw new LarkApiError("lark tenant_access_token response missing token", 0);
		}
		const expireSeconds = typeof body.expire === "number" && Number.isFinite(body.expire) ? body.expire : null;
		const ttlMs = expireSeconds !== null ? expireSeconds * 1000 : FALLBACK_TOKEN_TTL_MS;
		this.cached = { token, expiresAtMs: this.now() + Math.max(0, ttlMs - this.tokenSafetyWindowMs) };
		return token;
	}
}
