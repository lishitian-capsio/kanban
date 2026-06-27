/**
 * Orchestration seam for Gitee git authentication: the single object the runtime's `runGit`
 * injection, the tRPC endpoints, and the CLI all talk to.
 *
 * Responsibilities:
 *  - hold the machine-local PAT, re-reading from disk when the file changes on disk (so a
 *    `kanban gitee login` run in a *separate* process is picked up by a long-lived runtime
 *    without a restart);
 *  - hand `runGit` the gitee.com-scoped credential config + env when authenticated, and
 *    `null` (full passthrough) when not;
 *  - accept a pasted PAT (`login`) and remove it (`logout`).
 *
 * Simpler than the GitHub service by design (decision cf0d6): Gitee has no device flow, so
 * there is no polling, no pending-login persistence, and no token refresh. All collaborators
 * (login resolver, clock, file path) are injectable so the whole class is unit-testable
 * without network or `~/.kanban`.
 */
import { fetchGiteeUserLogin } from "./gitee-api";
import {
	clearPersistedGiteeAuth,
	getGiteeAuthFilePath,
	readPersistedGiteeAuth,
	statGiteeAuthMtimeMs,
	writePersistedGiteeAuth,
} from "./gitee-auth-store";
import type { GiteeAuthStatus, PersistedGiteeAuth } from "./gitee-auth-types";
import {
	buildGiteeCredentialConfigArgs,
	buildGiteeCredentialEnv,
	type GiteeGitInjection,
} from "./gitee-git-credentials";

export interface GiteeAuthServiceDeps {
	resolvePath?: () => string;
	now?: () => number;
	fetchUserLogin?: (token: string) => Promise<string | null>;
}

/** The pasted-PAT login input. `username` is optional but recommended (see cf0d6). */
export interface GiteeLoginInput {
	token: string;
	username?: string;
}

export class GiteeAuthService {
	private readonly resolvePath: () => string;
	private readonly now: () => number;
	private readonly fetchUserLogin: (token: string) => Promise<string | null>;
	private cache: { mtimeMs: number | null; record: PersistedGiteeAuth | null } | null = null;

	constructor(deps: GiteeAuthServiceDeps = {}) {
		this.resolvePath = deps.resolvePath ?? getGiteeAuthFilePath;
		this.now = deps.now ?? Date.now;
		this.fetchUserLogin = deps.fetchUserLogin ?? fetchGiteeUserLogin;
	}

	/** Re-read the credential from disk when the file's mtime has changed since last read. */
	private async loadRecord(): Promise<PersistedGiteeAuth | null> {
		const path = this.resolvePath();
		const mtimeMs = await statGiteeAuthMtimeMs(path);
		if (this.cache && this.cache.mtimeMs === mtimeMs) {
			return this.cache.record;
		}
		const record = mtimeMs === null ? null : await readPersistedGiteeAuth(path);
		this.cache = { mtimeMs, record };
		return record;
	}

	private statusOf(record: PersistedGiteeAuth | null): GiteeAuthStatus {
		if (!record) {
			return { authenticated: false, login: null, username: null };
		}
		return {
			authenticated: true,
			login: record.login ?? null,
			username: record.username ?? null,
		};
	}

	/** Public, secret-free auth state. */
	async getStatus(): Promise<GiteeAuthStatus> {
		return this.statusOf(await this.loadRecord());
	}

	/**
	 * The gitee.com-scoped credential config + env for `runGit`, or `null` when not
	 * authenticated (caller injects nothing — full passthrough).
	 */
	async getGitInjection(): Promise<GiteeGitInjection | null> {
		const record = await this.loadRecord();
		if (!record) {
			return null;
		}
		return {
			args: buildGiteeCredentialConfigArgs(),
			// The basic-auth username falls back to the account login (resolved at login time)
			// before the `oauth2` sentinel baked into buildGiteeCredentialEnv.
			env: buildGiteeCredentialEnv(record.accessToken, record.username ?? record.login),
		};
	}

	/**
	 * Persist a pasted PAT (+ optional username). Best-effort resolves the account login via
	 * the Gitee API for display; failure to resolve never blocks the login (the token still
	 * authenticates git). When no username was supplied, the resolved login is used as the
	 * basic-auth username so `username:PAT` is unambiguous.
	 */
	async login(input: GiteeLoginInput): Promise<GiteeAuthStatus> {
		const token = input.token.trim();
		if (!token) {
			throw new Error("A Gitee personal access token is required.");
		}
		const providedUsername = input.username?.trim() || undefined;
		const resolvedLogin = await this.fetchUserLogin(token);
		const record: PersistedGiteeAuth = {
			accessToken: token,
			issuedAt: this.now(),
		};
		const username = providedUsername ?? resolvedLogin ?? undefined;
		if (username) record.username = username;
		if (resolvedLogin) record.login = resolvedLogin;
		await writePersistedGiteeAuth(this.resolvePath(), record);
		this.cache = { mtimeMs: await statGiteeAuthMtimeMs(this.resolvePath()), record };
		// Intentionally no success log here: the console sink routes info to stdout, which would
		// corrupt a `--json` CLI envelope. The store layer still warns on failure (to stderr).
		return this.statusOf(record);
	}

	/** Remove the persisted credential (logout). Idempotent. */
	async logout(): Promise<void> {
		await clearPersistedGiteeAuth(this.resolvePath());
		this.cache = { mtimeMs: null, record: null };
	}
}

let singleton: GiteeAuthService | null = null;

/** The process-wide service (machine-global secret; no workspace scope). */
export function getGiteeAuthService(): GiteeAuthService {
	if (!singleton) {
		singleton = new GiteeAuthService();
	}
	return singleton;
}
