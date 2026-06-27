/**
 * Pure helpers that turn a Gitee PAT into the git command-line config and environment needed
 * to authenticate **gitee.com HTTPS** operations — and nothing else.
 *
 * Design constraints mirror the GitHub helper (see `github-git-credentials.ts`):
 *  - The token (and username) must NEVER land in repo config, a remote URL, or a process
 *    argument. We inject a *credential helper* (not a rewritten URL) whose body merely
 *    references environment variables; the secrets travel only in the per-spawn env. (This
 *    also avoids shell-injecting a user-supplied username into the helper string, which DOES
 *    appear in process args.)
 *  - Auth must apply ONLY to `https://gitee.com`. We use git's per-URL credential config
 *    (`credential.https://gitee.com.helper`), which git matches by host natively, so SSH
 *    remotes and every non-gitee host are left completely untouched.
 *  - When not logged in, callers inject nothing at all (full passthrough).
 *
 * The helper is a tiny POSIX-sh function. git invokes a `!`-prefixed helper as
 * `sh -c '<helper> "$@"' <helper> <operation>` (it appends `"$@"`), so the body is wrapped in
 * a function that ignores its arguments and prints the same credentials for every operation;
 * git only consumes stdout on `get`. This avoids the `printf`-format-cycling bug a bare
 * `printf … "$@"` would hit.
 */

/**
 * The git config flags + per-spawn env that authenticate gitee.com HTTPS ops. `runGit` merges
 * these in; `null` from the injector means "inject nothing" (full passthrough).
 */
export interface GiteeGitInjection {
	args: string[];
	env: NodeJS.ProcessEnv;
}

/** Resolves the current gitee.com git credential injection, or null when not logged in. */
export type GiteeGitAuthInjector = () => Promise<GiteeGitInjection | null>;

/** The single gitee.com origin we scope credentials to. SSH / other hosts are untouched. */
export const GITEE_HTTPS_ORIGIN = "https://gitee.com" as const;

/**
 * Environment variables that carry the secret + username to the git child process. Deliberately
 * runtime-internal (the runtime never sets these in its own `process.env`) — they are merged
 * only into the per-spawn env in {@link buildGiteeCredentialEnv}.
 */
export const GITEE_TOKEN_ENV_VAR = "KANBAN_GIT_GITEE_TOKEN" as const;
export const GITEE_USERNAME_ENV_VAR = "KANBAN_GIT_GITEE_USERNAME" as const;

/**
 * Fallback basic-auth username when none was captured. Gitee pairs `username:PAT` over HTTPS;
 * a real account username is the reliable default (we capture it), but `oauth2` is a sane
 * last-resort so a token-only login still attempts auth rather than silently doing nothing.
 */
export const GITEE_DEFAULT_USERNAME = "oauth2" as const;

/**
 * The inline POSIX-sh credential helper. Reads both the username and token from env vars so
 * neither secret is embedded in the helper string (which DOES appear in process args).
 */
const CREDENTIAL_HELPER_BODY = `!f() { printf 'username=%s\\npassword=%s\\n' "$${GITEE_USERNAME_ENV_VAR}" "$${GITEE_TOKEN_ENV_VAR}"; }; f`;

/** The config key git matches against `https://gitee.com/...` credential requests. */
const GITEE_CREDENTIAL_HELPER_KEY = `credential.${GITEE_HTTPS_ORIGIN}.helper`;

/**
 * The `-c key=value` flags to prepend to a `git` invocation so gitee.com HTTPS auth uses our
 * token. The first (empty) flag resets any lower-priority helper list **for gitee.com only**
 * so a stale system helper can't answer first; the second installs ours. Both are URL-scoped,
 * so non-gitee hosts keep their existing helpers untouched.
 *
 * Token-free by construction — safe to log and safe in `ps`. The secrets are supplied
 * separately via {@link buildGiteeCredentialEnv}.
 */
export function buildGiteeCredentialConfigArgs(): string[] {
	return ["-c", `${GITEE_CREDENTIAL_HELPER_KEY}=`, "-c", `${GITEE_CREDENTIAL_HELPER_KEY}=${CREDENTIAL_HELPER_BODY}`];
}

/**
 * The per-spawn environment additions carrying the secret + username. `GIT_TERMINAL_PROMPT=0`
 * makes git fail fast instead of blocking on a TTY prompt when the token is rejected —
 * important for the headless deployments this feature targets.
 */
export function buildGiteeCredentialEnv(token: string, username?: string | null): NodeJS.ProcessEnv {
	return {
		[GITEE_TOKEN_ENV_VAR]: token,
		[GITEE_USERNAME_ENV_VAR]: username?.trim() || GITEE_DEFAULT_USERNAME,
		GIT_TERMINAL_PROMPT: "0",
	};
}
