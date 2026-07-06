/**
 * Persistence for machine-local IM **outbound credentials** (bot tokens / webhook URLs).
 *
 * Follows the machine-home secrets convention (`~/.kanban/settings/im-credentials.json`, same
 * place as `github-auth.json` / `gitee-auth.json` / `passcode.json`): it lives outside any
 * repository checkout, so it is NEVER committed and never travels with a clone. The file is
 * written owner-only (`0o600`). The credential VALUES are never logged — only non-ENOENT I/O
 * errors are surfaced as warnings (error object only, no secret content).
 */
import { chmod, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { getMachineKanbanHomePath } from "../state/workspace-state";
import {
	type ImOutboundCredential,
	type ImPlatform,
	type PersistedImCredentials,
	persistedImCredentialsSchema,
} from "./types";

const log = createLogger("im.credential-store");

/**
 * Absolute path to the persisted IM credentials. Honors `KANBAN_IM_CREDENTIALS_FILE` (mirrors
 * `KANBAN_GITHUB_AUTH_FILE` / `KANBAN_GITEE_AUTH_FILE`); otherwise machine-home `settings/`.
 */
export function getImCredentialsFilePath(): string {
	const override = process.env.KANBAN_IM_CREDENTIALS_FILE?.trim();
	if (override) {
		return override;
	}
	return join(getMachineKanbanHomePath(), "settings", "im-credentials.json");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * Read the persisted credentials. Missing/torn/invalid file ⇒ `null`, so a corrupt secret file
 * degrades to "no credentials configured" rather than throwing.
 */
export async function readPersistedImCredentials(path: string): Promise<PersistedImCredentials | null> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = persistedImCredentialsSchema.safeParse(JSON.parse(raw) as unknown);
		return parsed.success ? parsed.data : null;
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to read persisted im credentials; treating as unconfigured", { error });
		}
		return null;
	}
}

/** Persist the credentials (machine-local secret; owner-only perms, no repo lock). */
export async function writePersistedImCredentials(path: string, record: PersistedImCredentials): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, record, { lock: null });
	try {
		await chmod(path, 0o600);
	} catch (error) {
		log.warn("failed to restrict im credentials file permissions", { error });
	}
}

/** Remove the persisted credentials. Missing file is not an error. */
export async function clearPersistedImCredentials(path: string): Promise<void> {
	try {
		await rm(path, { force: true });
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to remove persisted im credentials", { error });
		}
	}
}

/** Last-modified time (epoch ms) of the credentials file, or `null` when absent. */
export async function statImCredentialsMtimeMs(path: string): Promise<number | null> {
	try {
		const info = await stat(path);
		return info.mtimeMs;
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to stat im credentials file", { error });
		}
		return null;
	}
}

/**
 * Resolve a single platform's outbound credential from the store, or `null` when the file is
 * absent / unconfigured for that platform. The path defaults to {@link getImCredentialsFilePath}
 * but is injectable for tests. This is the seam a concrete adapter uses to self-resolve its secret.
 */
export async function resolveImCredential(
	platform: ImPlatform,
	path: string = getImCredentialsFilePath(),
): Promise<ImOutboundCredential | null> {
	const record = await readPersistedImCredentials(path);
	return record?.[platform] ?? null;
}
