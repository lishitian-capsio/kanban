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
 * Migrate a raw on-disk vault-settings object to the current
 * `agentVaultManagementEnabled` boolean shape.
 *
 * The setting has had three shapes over time: a boolean `managed` flag, then a
 * four-tier `vaultMode` enum (`off`/`cli-only`/`on-demand`/`managed`), and now a
 * plain boolean again. To keep existing workspaces working we map the legacy field
 * on read, collapsing the enum to on/off: `vaultMode === "managed"` (or the even
 * older `managed: true`) → `true`, and every other value (including `off` or an
 * absent field) → `false`. New-shape objects (already carrying
 * `agentVaultManagementEnabled`) pass through untouched, and non-object input is
 * returned as-is so the schema validation downstream can reject it with a clear
 * error. The legacy keys are dropped so they don't linger on disk after the next
 * write.
 *
 * Pure and side-effect-free so the migration is unit-testable.
 */
export function migrateRawVaultSettings(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) {
		return raw;
	}
	const record = raw as Record<string, unknown>;
	if ("agentVaultManagementEnabled" in record) {
		return record;
	}
	const enabled = record.vaultMode === "managed" || record.managed === true;
	const next: Record<string, unknown> = { ...record, agentVaultManagementEnabled: enabled };
	delete next.vaultMode;
	delete next.managed;
	return next;
}

/**
 * Repo-scoped store for workspace-level vault settings — the vault-takeover switch
 * ({@link RuntimeVaultSettings.agentVaultManagementEnabled}), the agent
 * database-access gate, and the extra push remotes. Persisted as a single committed
 * file at `<repo>/.kanban/files/settings.json`, sibling to the doc/view shards, so
 * the settings travel with the vault.
 *
 * Reads degrade to the schema defaults (everything off) when the file is absent,
 * and migrate the legacy `managed` boolean / `vaultMode` enum shapes via
 * {@link migrateRawVaultSettings}. Writes serialize on the **same directory lock
 * as the document, blob, and view channels** (the shared `files/` dir) so
 * settings writes never interleave with doc writes.
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
		return await this.readSettings();
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

	/**
	 * Apply a partial update: only the provided fields are changed, omitted fields
	 * keep their current persisted value. The read-modify-write runs under the same
	 * directory lock as {@link set} so two independent settings cards (vault mode and
	 * extra push remotes) can save concurrently without clobbering each other.
	 */
	async update(patch: Partial<RuntimeVaultSettings>): Promise<RuntimeVaultSettings> {
		await mkdir(this.filesDir, { recursive: true });
		return await lockedFileSystem.withLock({ type: "directory", path: this.filesDir }, async () => {
			const current = await this.readSettings();
			const next = runtimeVaultSettingsSchema.parse({
				...current,
				...(patch.agentVaultManagementEnabled !== undefined
					? { agentVaultManagementEnabled: patch.agentVaultManagementEnabled }
					: {}),
				...(patch.extraPushRemotes !== undefined ? { extraPushRemotes: patch.extraPushRemotes } : {}),
				...(patch.agentDatabaseAccessEnabled !== undefined
					? { agentDatabaseAccessEnabled: patch.agentDatabaseAccessEnabled }
					: {}),
			});
			await lockedFileSystem.writeJsonFileAtomic(this.settingsPath, next, { lock: null });
			return next;
		});
	}

	/** Read + migrate + default the persisted settings (no lock — callers hold it). */
	private async readSettings(): Promise<RuntimeVaultSettings> {
		const raw = await this.readRaw();
		if (raw === null) {
			return runtimeVaultSettingsSchema.parse({});
		}
		const parsed = runtimeVaultSettingsSchema.safeParse(migrateRawVaultSettings(raw));
		if (!parsed.success) {
			throw new Error(
				`Invalid vault settings file at ${this.settingsPath}. Fix or remove the file. ` +
					`Validation errors: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
			);
		}
		return parsed.data;
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
