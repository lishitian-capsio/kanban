/**
 * Persistence for the machine-local STT config (endpoint + key) used by the chat
 * composer's voice input.
 *
 * Follows the machine-home secrets convention (`~/.kanban/settings/stt-config.json`,
 * same place as `github-auth.json` / `passcode.json`): it lives outside any repository
 * checkout, so it is NEVER committed and never travels with a clone. The file is written
 * with owner-only (`0o600`) permissions because it can carry an API key.
 */
import { chmod, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { getMachineKanbanHomePath } from "../state/workspace-state";
import { type PersistedSttConfig, persistedSttConfigSchema } from "./stt-types";

const log = createLogger("stt.store");

/**
 * Absolute path to the persisted STT config. Honors `KANBAN_STT_CONFIG_FILE`
 * (mirrors `KANBAN_GITHUB_AUTH_FILE` / `KANBAN_PASSCODE_FILE`); otherwise machine-home
 * `settings/`.
 */
export function getSttConfigFilePath(): string {
	const override = process.env.KANBAN_STT_CONFIG_FILE?.trim();
	if (override) {
		return override;
	}
	return join(getMachineKanbanHomePath(), "settings", "stt-config.json");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Read the persisted config. Missing/torn/invalid file ⇒ `null` (treated as unconfigured). */
export async function readPersistedSttConfig(path: string): Promise<PersistedSttConfig | null> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = persistedSttConfigSchema.safeParse(JSON.parse(raw) as unknown);
		return parsed.success ? parsed.data : null;
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to read persisted stt config; treating as unconfigured", { error });
		}
		return null;
	}
}

/** Persist the config (machine-local secret; owner-only perms, no repo lock). */
export async function writePersistedSttConfig(path: string, config: PersistedSttConfig): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, config, { lock: null });
	try {
		await chmod(path, 0o600);
	} catch (error) {
		log.warn("failed to restrict stt config file permissions", { error });
	}
}

/** Remove the persisted config. Missing file is not an error (already unconfigured). */
export async function clearPersistedSttConfig(path: string): Promise<void> {
	try {
		await rm(path, { force: true });
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to remove persisted stt config", { error });
		}
	}
}

/** Last-modified time (epoch ms) of the config file, or `null` when absent. */
export async function statSttConfigMtimeMs(path: string): Promise<number | null> {
	try {
		const info = await stat(path);
		return info.mtimeMs;
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to stat stt config file", { error });
		}
		return null;
	}
}
