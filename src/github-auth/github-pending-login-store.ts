/**
 * Persistence for an **in-flight** GitHub device-flow login (the `deviceCode` + prompt the
 * runtime polls with). Mirrors the machine-local secret convention of
 * {@link ./github-auth-store} (`~/.kanban/settings/github-login-pending.json`, 0600): it
 * lives outside any repository checkout, is never committed, and never travels with a clone.
 *
 * See {@link ../github-auth/github-auth-types.PendingGitHubLogin} for why the in-flight login
 * is persisted server-side instead of held in the browser.
 */
import { chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { getMachineKanbanHomePath } from "../state/workspace-state";
import { type PendingGitHubLogin, pendingGitHubLoginSchema } from "./github-auth-types";

const log = createLogger("github-auth.pending-store");

/**
 * Absolute path to the persisted pending login. Honors `KANBAN_GITHUB_LOGIN_PENDING_FILE`
 * (mirrors `KANBAN_GITHUB_AUTH_FILE`); otherwise machine-home `settings/`.
 */
export function getGitHubPendingLoginFilePath(): string {
	const override = process.env.KANBAN_GITHUB_LOGIN_PENDING_FILE?.trim();
	if (override) {
		return override;
	}
	return join(getMachineKanbanHomePath(), "settings", "github-login-pending.json");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * Read the persisted pending login. Missing/torn/invalid file ⇒ `null` (no active login), so
 * a corrupt file degrades to "no pending login" rather than throwing.
 */
export async function readPendingGitHubLogin(path: string): Promise<PendingGitHubLogin | null> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = pendingGitHubLoginSchema.safeParse(JSON.parse(raw) as unknown);
		return parsed.success ? parsed.data : null;
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to read pending github login; treating as no pending login", { error });
		}
		return null;
	}
}

/** Persist the pending login (machine-local; owner-only perms, no repo lock). */
export async function writePendingGitHubLogin(path: string, record: PendingGitHubLogin): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, record, { lock: null });
	try {
		await chmod(path, 0o600);
	} catch (error) {
		log.warn("failed to restrict pending github login file permissions", { error });
	}
}

/** Remove the persisted pending login. Missing file is not an error. */
export async function clearPendingGitHubLogin(path: string): Promise<void> {
	try {
		await rm(path, { force: true });
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to remove pending github login", { error });
		}
	}
}
