/**
 * Pure helpers that turn a GitHub OAuth token into the git command-line config and
 * environment needed to authenticate **github.com HTTPS** operations — and nothing else.
 *
 * Design constraints (see AGENTS.md "GitHub OAuth git auth"):
 *  - The token must NEVER land in repo config, a remote URL, or a process argument. We
 *    therefore inject a *credential helper* (not a rewritten URL) whose body merely
 *    references an environment variable; the secret travels only in that per-spawn env.
 *  - Auth must apply ONLY to `https://github.com`. We use git's per-URL credential config
 *    (`credential.https://github.com.helper`), which git matches by host natively, so SSH
 *    remotes and every non-github host are left completely untouched.
 *  - When not logged in, callers inject nothing at all (full passthrough — today's behavior).
 *
 * The helper is a tiny POSIX-sh function. git invokes a `!`-prefixed helper as
 * `sh -c '<helper> "$@"' <helper> <operation>` (it appends `"$@"`, so the operation —
 * get/store/erase — arrives as a positional arg). Wrapping the body in a function that
 * ignores its arguments means it prints the same credentials for every operation; git only
 * consumes stdout on `get`, so emitting on store/erase is harmless. This avoids the
 * `printf`-format-cycling bug a bare `printf … "$@"` would hit.
 */

/**
 * The git config flags + per-spawn env that authenticate github.com HTTPS ops. `runGit`
 * merges these in; `null` from the injector means "inject nothing" (full passthrough).
 */
export interface GitHubGitInjection {
	args: string[];
	env: NodeJS.ProcessEnv;
}

/** Resolves the current github.com git credential injection, or null when not logged in. */
export type GitHubGitAuthInjector = () => Promise<GitHubGitInjection | null>;

/** The single github.com origin we scope credentials to. SSH / other hosts are untouched. */
export const GITHUB_HTTPS_ORIGIN = "https://github.com" as const;

/**
 * Environment variable that carries the token to the git child process. Deliberately
 * runtime-internal (the runtime never sets this in its own `process.env`) — it is merged
 * only into the per-spawn env in {@link buildGitHubCredentialEnv}.
 */
export const GITHUB_TOKEN_ENV_VAR = "KANBAN_GIT_GITHUB_TOKEN" as const;

/**
 * The username half of the basic-auth pair. GitHub accepts `x-access-token:<token>` for
 * OAuth/PAT/App tokens over HTTPS (the same convention `actions/checkout` uses), so the
 * token itself is never the username and the pair works across all GitHub token types.
 */
const GITHUB_CREDENTIAL_USERNAME = "x-access-token" as const;

/**
 * The inline POSIX-sh credential helper. Reads the token from {@link GITHUB_TOKEN_ENV_VAR}
 * so the secret is never embedded in the helper string (which DOES appear in process args).
 */
const CREDENTIAL_HELPER_BODY = `!f() { printf 'username=${GITHUB_CREDENTIAL_USERNAME}\\npassword=%s\\n' "$${GITHUB_TOKEN_ENV_VAR}"; }; f`;

/** The config key git matches against `https://github.com/...` credential requests. */
const GITHUB_CREDENTIAL_HELPER_KEY = `credential.${GITHUB_HTTPS_ORIGIN}.helper`;

/**
 * The `-c key=value` flags to prepend to a `git` invocation so github.com HTTPS auth uses
 * our token. The first (empty) flag resets any lower-priority helper list **for github.com
 * only** so a stale system helper can't answer first; the second installs ours. Both are
 * URL-scoped, so non-github hosts keep their existing helpers untouched.
 *
 * Token-free by construction — safe to log and safe in `ps`. The secret is supplied
 * separately via {@link buildGitHubCredentialEnv}.
 */
export function buildGitHubCredentialConfigArgs(): string[] {
	return ["-c", `${GITHUB_CREDENTIAL_HELPER_KEY}=`, "-c", `${GITHUB_CREDENTIAL_HELPER_KEY}=${CREDENTIAL_HELPER_BODY}`];
}

/**
 * The per-spawn environment additions carrying the secret. `GIT_TERMINAL_PROMPT=0` makes
 * git fail fast instead of blocking on a TTY prompt when the token is rejected — important
 * for the headless deployments this feature targets.
 */
export function buildGitHubCredentialEnv(token: string): NodeJS.ProcessEnv {
	return {
		[GITHUB_TOKEN_ENV_VAR]: token,
		GIT_TERMINAL_PROMPT: "0",
	};
}
