/**
 * Persistence for the machine-local GitHub OAuth credential used for git remote auth.
 *
 * Follows the machine-home secrets convention (`~/.kanban/settings/github-auth.json`, same
 * place as `passcode.json` / `db-credentials.json`): it lives outside any repository
 * checkout, so it is NEVER committed and never travels with a clone. The file is written
 * with owner-only (`0o600`) permissions.
 */
import { chmod, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { getMachineKanbanHomePath } from "../state/workspace-state";
import { type PersistedGitHubAuth, persistedGitHubAuthSchema } from "./github-auth-types";

const log = createLogger("github-auth.store");

/**
 * Absolute path to the persisted GitHub credential. Honors `KANBAN_GITHUB_AUTH_FILE`
 * (mirrors `KANBAN_PASSCODE_FILE` / `KANBAN_DB_CREDENTIALS_PATH`); otherwise machine-home
 * `settings/`.
 */
export function getGitHubAuthFilePath(): string {
	const override = process.env.KANBAN_GITHUB_AUTH_FILE?.trim();
	if (override) {
		return override;
	}
	return join(getMachineKanbanHomePath(), "settings", "github-auth.json");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * Read the persisted credential. Missing/torn/invalid file ⇒ `null` (treated as logged
 * out), so a corrupt secret file degrades to "not authenticated" rather than throwing.
 */
export async function readPersistedGitHubAuth(path: string): Promise<PersistedGitHubAuth | null> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = persistedGitHubAuthSchema.safeParse(JSON.parse(raw) as unknown);
		return parsed.success ? parsed.data : null;
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to read persisted github auth; treating as logged out", { error });
		}
		return null;
	}
}

/** Persist the credential (machine-local secret; owner-only perms, no repo lock). */
export async function writePersistedGitHubAuth(path: string, record: PersistedGitHubAuth): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, record, { lock: null });
	try {
		await chmod(path, 0o600);
	} catch (error) {
		log.warn("failed to restrict github auth file permissions", { error });
	}
}

/** Remove the persisted credential. Missing file is not an error (already logged out). */
export async function clearPersistedGitHubAuth(path: string): Promise<void> {
	try {
		await rm(path, { force: true });
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to remove persisted github auth", { error });
		}
	}
}

/** Last-modified time (epoch ms) of the credential file, or `null` when absent. */
export async function statGitHubAuthMtimeMs(path: string): Promise<number | null> {
	try {
		const info = await stat(path);
		return info.mtimeMs;
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to stat github auth file", { error });
		}
		return null;
	}
}
