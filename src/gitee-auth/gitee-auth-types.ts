/**
 * Shared types + persisted schema for the machine-local Gitee Personal Access Token (PAT)
 * used for **git remote authentication** over gitee.com HTTPS. Intentionally isolated from
 * the pi/omp agent-model OAuth store (`src/agent-sdk/ai/utils/oauth/`) — they must never
 * share storage or types.
 *
 * Unlike GitHub, Gitee has NO OAuth Device Authorization Grant (device flow), so there is no
 * device-code / pending-login machinery here: the user pastes a PAT (私人令牌) generated on
 * gitee.com and Kanban stores it. See the decision "Gitee git auth uses a pasted PAT, and the
 * runGit credential injector goes host-keyed" (cf0d6).
 */
import { z } from "zod";

/**
 * On-disk shape of `~/.kanban/settings/gitee-auth.json`. Mirrors the passcode/db-credential
 * machine-local secret convention: never committed, never written into `<repo>/.kanban`.
 *
 * There is no `refreshToken`/`expiresAt`: a Gitee PAT cannot be refreshed (the user re-pastes
 * a new one when it expires), so unlike GitHub's OAuth token there is nothing to refresh.
 */
export const persistedGiteeAuthSchema = z.object({
	/** The Gitee personal access token used as the git HTTPS password. */
	accessToken: z.string().min(1),
	/**
	 * The HTTPS basic-auth username paired with the PAT. Gitee verifies `username:PAT`, and a
	 * fixed sentinel (e.g. `oauth2`) is not reliable for PATs, so we capture the real account
	 * username. Optional on disk; absent ⇒ the credential helper falls back to `oauth2`.
	 */
	username: z.string().min(1).optional(),
	/** Gitee account login resolved at login time (for display in `status`). */
	login: z.string().optional(),
	/** Epoch ms the credential was stored. */
	issuedAt: z.number().int().positive().optional(),
});

export type PersistedGiteeAuth = z.infer<typeof persistedGiteeAuthSchema>;

/**
 * Public, secret-free view of the current auth state. Returned by the service / tRPC / CLI
 * `status` — never includes the token itself.
 */
export interface GiteeAuthStatus {
	authenticated: boolean;
	/** Gitee account login resolved from the API, or null when not resolved / logged out. */
	login: string | null;
	/** The basic-auth username captured at login (may equal `login`), or null when logged out. */
	username: string | null;
}
