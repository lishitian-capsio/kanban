/**
 * GitHub OAuth **device flow** for git remote authentication — a fresh, standalone
 * implementation (the agent-model OAuth under `src/agent-sdk/ai/utils/oauth/` is deliberately
 * NOT reused or imported here, to keep git auth isolated from pi/omp model auth).
 *
 * Device flow is the right fit for headless / remote Linux deployments: the runtime prints
 * a short user code + verification URL, the operator authorizes in any browser, and the
 * runtime polls for the token. No callback server / open port is required.
 *
 * @see https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */
import { scheduler } from "node:timers/promises";
import { createLogger } from "../logging";

const log = createLogger("github-auth.device-flow");

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_API_URL = "https://api.github.com/user";

/**
 * OAuth **client id** for the device flow. A client id is public (not a secret) and device
 * flow requires no client secret. Override with `KANBAN_GITHUB_OAUTH_CLIENT_ID` to point at
 * an organization's own GitHub OAuth App. The default is the GitHub CLI's well-known public
 * device-flow client id, which supports `repo` scope out of the box so headless setups work
 * with zero configuration.
 */
const DEFAULT_CLIENT_ID = "178c6fc778ccc68e1d6a";

/** Scopes requested for git remote operations: full `repo` (push/pull private + public). */
export const GITHUB_GIT_OAUTH_SCOPE = "repo";

export function resolveGitHubOAuthClientId(): string {
	return process.env.KANBAN_GITHUB_OAUTH_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
}

export interface DeviceCodeGrant {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** Recommended minimum polling interval (seconds). */
	intervalSeconds: number;
	/** Seconds until the device/user code pair expires. */
	expiresInSeconds: number;
}

export interface GitHubTokenGrant {
	accessToken: string;
	refreshToken?: string;
	/** Seconds until `accessToken` expires; absent for long-lived (non-expiring) tokens. */
	expiresInSeconds?: number;
	scope?: string;
}

const JSON_HEADERS = {
	Accept: "application/json",
	"Content-Type": "application/json",
} as const;

async function postJson(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`GitHub request failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`);
	}
	const parsed = (await response.json()) as unknown;
	if (!parsed || typeof parsed !== "object") {
		throw new Error("GitHub returned an unexpected (non-object) response");
	}
	return parsed as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Step 1: request a device + user code pair. */
export async function requestDeviceCode(clientId = resolveGitHubOAuthClientId()): Promise<DeviceCodeGrant> {
	const data = await postJson(DEVICE_CODE_URL, { client_id: clientId, scope: GITHUB_GIT_OAUTH_SCOPE });
	const deviceCode = asString(data.device_code);
	const userCode = asString(data.user_code);
	const verificationUri = asString(data.verification_uri);
	const intervalSeconds = asNumber(data.interval);
	const expiresInSeconds = asNumber(data.expires_in);
	if (
		!deviceCode ||
		!userCode ||
		!verificationUri ||
		intervalSeconds === undefined ||
		expiresInSeconds === undefined
	) {
		throw new Error("GitHub device code response was missing required fields");
	}
	return { deviceCode, userCode, verificationUri, intervalSeconds, expiresInSeconds };
}

function parseTokenGrant(data: Record<string, unknown>): GitHubTokenGrant | null {
	const accessToken = asString(data.access_token);
	if (!accessToken) {
		return null;
	}
	return {
		accessToken,
		refreshToken: asString(data.refresh_token),
		expiresInSeconds: asNumber(data.expires_in),
		scope: asString(data.scope),
	};
}

/**
 * Result of a single token-endpoint poll. `pending`/`slow_down` mean "keep waiting"; `token`
 * is success; `error` is a terminal device-flow failure (denied / expired / bad code).
 */
export type PollAttempt =
	| { kind: "token"; grant: GitHubTokenGrant }
	| { kind: "pending" }
	| { kind: "slow_down"; intervalSeconds: number | undefined }
	| { kind: "error"; message: string };

/**
 * One poll of the token endpoint. The non-blocking primitive a browser UI drives on an
 * interval (via tRPC), and the building block {@link pollForAccessToken} loops over for the
 * blocking CLI flow.
 */
export async function pollAccessTokenOnce(
	deviceCode: string,
	clientId = resolveGitHubOAuthClientId(),
): Promise<PollAttempt> {
	const data = await postJson(ACCESS_TOKEN_URL, {
		client_id: clientId,
		device_code: deviceCode,
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
	});
	const token = parseTokenGrant(data);
	if (token) {
		return { kind: "token", grant: token };
	}
	const error = asString(data.error);
	if (error === "authorization_pending") {
		return { kind: "pending" };
	}
	if (error === "slow_down") {
		return { kind: "slow_down", intervalSeconds: asNumber(data.interval) };
	}
	const description = asString(data.error_description);
	return { kind: "error", message: `${error ?? "unknown error"}${description ? ` — ${description}` : ""}` };
}

export interface PollOptions {
	signal?: AbortSignal;
	/** Test seam: override the wait primitive so polling is instant under unit tests. */
	wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Test seam: override the single-attempt poll. */
	pollOnce?: (deviceCode: string, clientId: string) => Promise<PollAttempt>;
}

const defaultWait = (ms: number, signal?: AbortSignal) => scheduler.wait(ms, { signal });

/**
 * Step 2 (blocking): poll the token endpoint until the user authorizes (or the code
 * expires). Honors `authorization_pending` (keep waiting) and `slow_down` (back off by the
 * server-provided interval), per the device-flow spec. Used by the CLI login.
 */
export async function pollForAccessToken(
	grant: DeviceCodeGrant,
	clientId = resolveGitHubOAuthClientId(),
	options: PollOptions = {},
): Promise<GitHubTokenGrant> {
	const wait = options.wait ?? defaultWait;
	const pollOnce = options.pollOnce ?? pollAccessTokenOnce;
	const deadline = Date.now() + grant.expiresInSeconds * 1000;
	let intervalMs = Math.max(1000, grant.intervalSeconds * 1000);

	while (Date.now() < deadline) {
		if (options.signal?.aborted) {
			throw new Error("GitHub login cancelled");
		}
		try {
			await wait(intervalMs, options.signal);
		} catch {
			throw new Error("GitHub login cancelled");
		}

		const attempt = await pollOnce(grant.deviceCode, clientId);
		if (attempt.kind === "token") {
			return attempt.grant;
		}
		if (attempt.kind === "pending") {
			continue;
		}
		if (attempt.kind === "slow_down") {
			intervalMs = Math.max(intervalMs + 5000, attempt.intervalSeconds ? attempt.intervalSeconds * 1000 : 0);
			continue;
		}
		throw new Error(`GitHub device flow failed: ${attempt.message}`);
	}
	throw new Error("GitHub device flow timed out before authorization");
}

/**
 * Refresh an expiring token. Only used when the OAuth app has token expiration enabled
 * (a `refresh_token` was issued). Returns the new grant.
 */
export async function refreshAccessToken(
	refreshToken: string,
	clientId = resolveGitHubOAuthClientId(),
): Promise<GitHubTokenGrant> {
	const data = await postJson(ACCESS_TOKEN_URL, {
		client_id: clientId,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	const token = parseTokenGrant(data);
	if (!token) {
		const error = asString(data.error);
		const description = asString(data.error_description);
		throw new Error(
			`GitHub token refresh failed: ${error ?? "unknown error"}${description ? ` — ${description}` : ""}`,
		);
	}
	return token;
}

/** Resolve the authenticated user's login (username) for display. Best-effort. */
export async function fetchAuthenticatedLogin(accessToken: string): Promise<string | null> {
	try {
		const response = await fetch(USER_API_URL, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${accessToken}`,
				"User-Agent": "kanban-git-auth",
			},
		});
		if (!response.ok) {
			return null;
		}
		const data = (await response.json()) as { login?: unknown };
		return asString(data.login) ?? null;
	} catch (error) {
		log.warn("failed to resolve github login", { error });
		return null;
	}
}
