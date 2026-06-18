import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeVaultSettings } from "../core/api-contract";
import { runtimeVaultSettingsSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { resolveBoardDataLocation } from "../state/workspace-state";

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

const FILES_DIR = "files";
const SETTINGS_FILENAME = "settings.json";

/**
 * Repo-scoped store for workspace-level vault settings — currently just the
 * vault-takeover switch ({@link RuntimeVaultSettings.managed}). Persisted as a
 * single committed file at `<repo>/.kanban/files/settings.json`, sibling to the
 * doc/view shards, so the setting travels with the vault.
 *
 * Reads degrade to the schema defaults (`managed: false`) when the file is
 * absent. Writes serialize on the **same directory lock as the document, blob,
 * and view channels** (the shared `files/` dir) so settings writes never
 * interleave with doc writes.
 */
export class VaultSettingsStore {
	private readonly filesDir: string;
	private readonly settingsPath: string;

	constructor(repoPath: string) {
		this.filesDir = join(resolveBoardDataLocation(repoPath).boardDataHome, FILES_DIR);
		this.settingsPath = join(this.filesDir, SETTINGS_FILENAME);
	}

	/** Read the persisted vault settings, defaulting to unmanaged when absent. */
	async get(): Promise<RuntimeVaultSettings> {
		const raw = await this.readRaw();
		if (raw === null) {
			return runtimeVaultSettingsSchema.parse({});
		}
		const parsed = runtimeVaultSettingsSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(
				`Invalid vault settings file at ${this.settingsPath}. Fix or remove the file. ` +
					`Validation errors: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
			);
		}
		return parsed.data;
	}

	/** Persist the given vault settings, returning the normalized value. */
	async set(settings: RuntimeVaultSettings): Promise<RuntimeVaultSettings> {
		const next = runtimeVaultSettingsSchema.parse(settings);
		await mkdir(this.filesDir, { recursive: true });
		return await lockedFileSystem.withLock({ type: "directory", path: this.filesDir }, async () => {
			await lockedFileSystem.writeJsonFileAtomic(this.settingsPath, next, { lock: null });
			return next;
		});
	}

	private async readRaw(): Promise<unknown | null> {
		try {
			return JSON.parse(await readFile(this.settingsPath, "utf8")) as unknown;
		} catch (error) {
			if (isNodeErrorWithCode(error, "ENOENT")) {
				return null;
			}
			throw error;
		}
	}
}
