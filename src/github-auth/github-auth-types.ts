/**
 * Shared types + persisted schema for the machine-local GitHub OAuth credential used for
 * **git remote authentication**. This is intentionally isolated from the pi/omp agent-model
 * OAuth store (`src/agent-sdk/ai/utils/oauth/`) — they must never share storage or types.
 */
import { z } from "zod";

/**
 * On-disk shape of `~/.kanban/settings/github-auth.json`. Mirrors the passcode/db-credential
 * machine-local secret convention: never committed, never written into `<repo>/.kanban`.
 *
 * `expiresAt`/`refreshToken` are only present when the OAuth app has token expiration
 * enabled; classic GitHub OAuth apps issue long-lived tokens with neither field.
 */
export const persistedGitHubAuthSchema = z.object({
	/** The OAuth access token used as the git HTTPS password. */
	accessToken: z.string().min(1),
	/** Optional refresh token (only when the app enables token expiration). */
	refreshToken: z.string().min(1).optional(),
	/** Epoch ms when `accessToken` expires; absent ⇒ treated as long-lived. */
	expiresAt: z.number().int().positive().optional(),
	/** Space-delimited granted scopes, as returned by the token endpoint. */
	scope: z.string().optional(),
	/** GitHub login (username) resolved at login time, for display in `status`. */
	login: z.string().optional(),
	/** Epoch ms the credential was stored. */
	issuedAt: z.number().int().positive().optional(),
});

export type PersistedGitHubAuth = z.infer<typeof persistedGitHubAuthSchema>;

/**
 * Public, secret-free view of the current auth state. Returned by the service / tRPC /
 * CLI `status` — never includes the token itself.
 */
export interface GitHubAuthStatus {
	authenticated: boolean;
	login: string | null;
	scope: string | null;
	/** Epoch ms of token expiry, or null when long-lived / not logged in. */
	expiresAt: number | null;
}
