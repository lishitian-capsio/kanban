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
 * On-disk shape of an **in-flight** device-flow login (`github-login-pending.json`).
 *
 * Why this is persisted server-side rather than held in the browser: the device-flow
 * `deviceCode` is the only thing that lets the runtime poll GitHub for the eventual token.
 * If it lives solely in a React component (as it did originally), a page refresh or a brief
 * tRPC/ws disconnect discards it and polling stops forever — so a user who authorized on
 * GitHub in that window is never granted a token and the UI is stuck on "Not signed in".
 *
 * Persisting it to the same machine-local 0600 settings dir as the credential (rather than
 * keeping it only in the long-lived runtime's memory) makes an in-flight login survive BOTH
 * a UI reload AND a runtime restart, and keeps the `deviceCode` off the wire entirely (the
 * UI polls a server-held record by no argument). The record is short-lived and cleared on
 * success, explicit cancel, or expiry, so a stale pending login can never block a fresh
 * sign-in.
 */
export const pendingGitHubLoginSchema = z.object({
	/** The device code used to poll the token endpoint. Treated as a secret (never logged). */
	deviceCode: z.string().min(1),
	/** The short user-facing code entered on github.com. */
	userCode: z.string().min(1),
	/** Where the user enters the code. */
	verificationUri: z.string().min(1),
	/** Server-recommended minimum poll interval (seconds). */
	intervalSeconds: z.number().int().nonnegative(),
	/** Epoch ms the login was started. */
	startedAt: z.number().int().positive(),
	/** Epoch ms the device/user code pair expires. */
	expiresAt: z.number().int().positive(),
});

export type PendingGitHubLogin = z.infer<typeof pendingGitHubLoginSchema>;

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
