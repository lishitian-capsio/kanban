/**
 * Minimal Gitee REST helper used only to resolve the authenticated account's login for
 * display. Best-effort: any failure returns `null` so a headless / offline login still
 * succeeds (the token is what authenticates git; the login is cosmetic).
 *
 * Gitee has no OAuth device flow, so — unlike GitHub — this module is the entirety of the
 * network surface (there is no device-flow / token-exchange counterpart).
 */
import { createLogger } from "../logging";

const log = createLogger("gitee-auth.api");

/** Gitee v5 "current user" endpoint. Accepts the PAT via the `Authorization` header. */
const USER_API_URL = "https://gitee.com/api/v5/user";

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Resolve the Gitee account login for a PAT, or `null` on any failure (invalid token,
 * network error, unexpected payload). Never throws.
 */
export async function fetchGiteeUserLogin(token: string): Promise<string | null> {
	try {
		const response = await fetch(USER_API_URL, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"User-Agent": "kanban-git-auth",
			},
		});
		if (!response.ok) {
			return null;
		}
		const data = (await response.json()) as { login?: unknown };
		return asString(data.login);
	} catch (error) {
		log.warn("failed to resolve gitee login", { error });
		return null;
	}
}
