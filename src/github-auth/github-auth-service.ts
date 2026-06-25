/**
 * Orchestration seam for GitHub git authentication: the single object the runtime's
 * `runGit` injection, the tRPC endpoints, and the CLI all talk to.
 *
 * Responsibilities:
 *  - hold the machine-local credential, re-reading from disk when the file changes on disk
 *    (so a `kanban github login` run in a *separate* process is picked up by a long-lived
 *    runtime without a restart);
 *  - transparently refresh an expiring token (apps with token expiration enabled);
 *  - hand `runGit` the github.com-scoped credential config + env when authenticated, and
 *    `null` (full passthrough) when not;
 *  - drive the device-flow login and the logout.
 *
 * All collaborators (device-flow calls, clock, file path) are injectable so the whole class
 * is unit-testable without network or `~/.kanban`.
 */
import { createLogger } from "../logging";
import {
	clearPersistedGitHubAuth,
	getGitHubAuthFilePath,
	readPersistedGitHubAuth,
	statGitHubAuthMtimeMs,
	writePersistedGitHubAuth,
} from "./github-auth-store";
import type { GitHubAuthStatus, PersistedGitHubAuth } from "./github-auth-types";
import {
	type DeviceCodeGrant,
	fetchAuthenticatedLogin,
	type GitHubTokenGrant,
	type PollAttempt,
	pollAccessTokenOnce,
	pollForAccessToken,
	refreshAccessToken,
	requestDeviceCode,
	resolveGitHubOAuthClientId,
} from "./github-device-flow";
import {
	buildGitHubCredentialConfigArgs,
	buildGitHubCredentialEnv,
	type GitHubGitInjection,
} from "./github-git-credentials";

const log = createLogger("github-auth.service");

/** Refresh slightly before the real expiry so an in-flight git op never races the boundary. */
const EXPIRY_SKEW_MS = 60_000;

export interface GitHubAuthServiceDeps {
	resolvePath?: () => string;
	now?: () => number;
	requestDeviceCode?: (clientId: string) => Promise<DeviceCodeGrant>;
	pollForAccessToken?: (
		grant: DeviceCodeGrant,
		clientId: string,
		options: { signal?: AbortSignal },
	) => Promise<GitHubTokenGrant>;
	pollAccessTokenOnce?: (deviceCode: string, clientId: string) => Promise<PollAttempt>;
	refreshAccessToken?: (refreshToken: string, clientId: string) => Promise<GitHubTokenGrant>;
	fetchAuthenticatedLogin?: (accessToken: string) => Promise<string | null>;
}

/** Result of a single non-blocking login poll (the browser-UI device-flow contract). */
export type GitHubLoginPollResult =
	| { state: "pending" }
	| { state: "complete"; status: GitHubAuthStatus }
	| { state: "error"; message: string };

export interface GitHubLoginCallbacks {
	/** Surface the verification URL + user code to the operator (printed by the CLI). */
	onPrompt: (grant: DeviceCodeGrant) => void;
	signal?: AbortSignal;
}

export class GitHubAuthService {
	private readonly resolvePath: () => string;
	private readonly now: () => number;
	private readonly deps: Required<Omit<GitHubAuthServiceDeps, "resolvePath" | "now">>;
	private cache: { mtimeMs: number | null; record: PersistedGitHubAuth | null } | null = null;
	private refreshInFlight: Promise<PersistedGitHubAuth | null> | null = null;

	constructor(deps: GitHubAuthServiceDeps = {}) {
		this.resolvePath = deps.resolvePath ?? getGitHubAuthFilePath;
		this.now = deps.now ?? Date.now;
		this.deps = {
			requestDeviceCode: deps.requestDeviceCode ?? requestDeviceCode,
			pollForAccessToken: deps.pollForAccessToken ?? pollForAccessToken,
			pollAccessTokenOnce: deps.pollAccessTokenOnce ?? pollAccessTokenOnce,
			refreshAccessToken: deps.refreshAccessToken ?? refreshAccessToken,
			fetchAuthenticatedLogin: deps.fetchAuthenticatedLogin ?? fetchAuthenticatedLogin,
		};
	}

	/** Re-read the credential from disk when the file's mtime has changed since last read. */
	private async loadRecord(): Promise<PersistedGitHubAuth | null> {
		const path = this.resolvePath();
		const mtimeMs = await statGitHubAuthMtimeMs(path);
		if (this.cache && this.cache.mtimeMs === mtimeMs) {
			return this.cache.record;
		}
		const record = mtimeMs === null ? null : await readPersistedGitHubAuth(path);
		this.cache = { mtimeMs, record };
		return record;
	}

	private isExpired(record: PersistedGitHubAuth): boolean {
		return record.expiresAt !== undefined && record.expiresAt <= this.now() + EXPIRY_SKEW_MS;
	}

	/** Resolve a usable (non-expired) credential, refreshing once if needed. */
	private async resolveUsableRecord(): Promise<PersistedGitHubAuth | null> {
		const record = await this.loadRecord();
		if (!record || !this.isExpired(record)) {
			return record;
		}
		if (!record.refreshToken) {
			// Expired and not refreshable — surface as logged out so callers fall back to
			// the system credential helper / SSH agent instead of pushing a dead token.
			log.warn("github token expired and has no refresh token; treating as logged out");
			return null;
		}
		if (!this.refreshInFlight) {
			this.refreshInFlight = this.performRefresh(record).finally(() => {
				this.refreshInFlight = null;
			});
		}
		return this.refreshInFlight;
	}

	private async performRefresh(record: PersistedGitHubAuth): Promise<PersistedGitHubAuth | null> {
		const refreshToken = record.refreshToken;
		if (!refreshToken) {
			return null;
		}
		try {
			const grant = await this.deps.refreshAccessToken(refreshToken, resolveGitHubOAuthClientId());
			const next = this.toRecord(grant, record.login ?? null, refreshToken);
			await writePersistedGitHubAuth(this.resolvePath(), next);
			this.cache = { mtimeMs: await statGitHubAuthMtimeMs(this.resolvePath()), record: next };
			return next;
		} catch (error) {
			log.error("github token refresh failed", { error });
			return null;
		}
	}

	private toRecord(grant: GitHubTokenGrant, login: string | null, fallbackRefresh?: string): PersistedGitHubAuth {
		const record: PersistedGitHubAuth = {
			accessToken: grant.accessToken,
			issuedAt: this.now(),
		};
		const refreshToken = grant.refreshToken ?? fallbackRefresh;
		if (refreshToken) record.refreshToken = refreshToken;
		if (grant.expiresInSeconds !== undefined) record.expiresAt = this.now() + grant.expiresInSeconds * 1000;
		if (grant.scope) record.scope = grant.scope;
		if (login) record.login = login;
		return record;
	}

	private statusOf(record: PersistedGitHubAuth | null): GitHubAuthStatus {
		if (!record) {
			return { authenticated: false, login: null, scope: null, expiresAt: null };
		}
		return {
			authenticated: true,
			login: record.login ?? null,
			scope: record.scope ?? null,
			expiresAt: record.expiresAt ?? null,
		};
	}

	/** Public, secret-free auth state (refreshes a stale token first, best effort). */
	async getStatus(): Promise<GitHubAuthStatus> {
		const record = await this.resolveUsableRecord();
		return this.statusOf(record);
	}

	/**
	 * The github.com-scoped credential config + env for `runGit`, or `null` when not
	 * authenticated (caller injects nothing — today's full-passthrough behavior).
	 */
	async getGitInjection(): Promise<GitHubGitInjection | null> {
		const record = await this.resolveUsableRecord();
		if (!record) {
			return null;
		}
		return {
			args: buildGitHubCredentialConfigArgs(),
			env: buildGitHubCredentialEnv(record.accessToken),
		};
	}

	/** Run the device-flow login end to end and persist the resulting credential. */
	async login(callbacks: GitHubLoginCallbacks): Promise<GitHubAuthStatus> {
		const clientId = resolveGitHubOAuthClientId();
		const grant = await this.deps.requestDeviceCode(clientId);
		callbacks.onPrompt(grant);
		const token = await this.deps.pollForAccessToken(grant, clientId, { signal: callbacks.signal });
		const login = await this.deps.fetchAuthenticatedLogin(token.accessToken);
		const record = this.toRecord(token, login);
		await writePersistedGitHubAuth(this.resolvePath(), record);
		this.cache = { mtimeMs: await statGitHubAuthMtimeMs(this.resolvePath()), record };
		return this.statusOf(record);
	}

	/**
	 * Step 1 of the non-blocking (UI) device flow: request a device + user code. The caller
	 * shows the code, then polls {@link pollLogin} with the returned `deviceCode`.
	 */
	async beginLogin(): Promise<DeviceCodeGrant> {
		return this.deps.requestDeviceCode(resolveGitHubOAuthClientId());
	}

	/**
	 * Step 2 of the non-blocking (UI) device flow: one poll. On `complete` the token is
	 * persisted and the new status returned; `pending` means "keep polling"; `error` is a
	 * terminal device-flow failure.
	 */
	async pollLogin(deviceCode: string): Promise<GitHubLoginPollResult> {
		const attempt = await this.deps.pollAccessTokenOnce(deviceCode, resolveGitHubOAuthClientId());
		if (attempt.kind === "token") {
			const login = await this.deps.fetchAuthenticatedLogin(attempt.grant.accessToken);
			const record = this.toRecord(attempt.grant, login);
			await writePersistedGitHubAuth(this.resolvePath(), record);
			this.cache = { mtimeMs: await statGitHubAuthMtimeMs(this.resolvePath()), record };
			return { state: "complete", status: this.statusOf(record) };
		}
		if (attempt.kind === "error") {
			return { state: "error", message: attempt.message };
		}
		return { state: "pending" };
	}

	/** Remove the persisted credential (logout). Idempotent. */
	async logout(): Promise<void> {
		await clearPersistedGitHubAuth(this.resolvePath());
		this.cache = { mtimeMs: null, record: null };
	}
}

let singleton: GitHubAuthService | null = null;

/** The process-wide service (machine-global secret; no workspace scope). */
export function getGitHubAuthService(): GitHubAuthService {
	if (!singleton) {
		singleton = new GitHubAuthService();
	}
	return singleton;
}
