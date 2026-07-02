import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateRawVaultSettings, VaultSettingsStore } from "../../../src/vault/vault-settings-store";

let repoPath: string;
let store: VaultSettingsStore;

const filesDir = () => join(repoPath, ".kanban", "files");
const settingsPath = () => join(filesDir(), "settings.json");

async function writeRawSettings(raw: unknown): Promise<void> {
	await mkdir(filesDir(), { recursive: true });
	await writeFile(settingsPath(), JSON.stringify(raw), "utf8");
}

beforeEach(async () => {
	repoPath = await mkdtemp(join(tmpdir(), "kanban-vault-settings-store-"));
	store = new VaultSettingsStore(repoPath);
});

afterEach(async () => {
	await rm(repoPath, { recursive: true, force: true });
});

describe("migrateRawVaultSettings", () => {
	it("maps the legacy vaultMode 'managed' enum to agentVaultManagementEnabled=true", () => {
		expect(migrateRawVaultSettings({ vaultMode: "managed" })).toEqual({ agentVaultManagementEnabled: true });
	});

	it("collapses the lower legacy vaultMode tiers to agentVaultManagementEnabled=false", () => {
		for (const vaultMode of ["off", "cli-only", "on-demand"]) {
			expect(migrateRawVaultSettings({ vaultMode })).toEqual({ agentVaultManagementEnabled: false });
		}
	});

	it("maps the even-older managed=true boolean to agentVaultManagementEnabled=true", () => {
		expect(migrateRawVaultSettings({ managed: true })).toEqual({ agentVaultManagementEnabled: true });
	});

	it("maps managed=false to agentVaultManagementEnabled=false", () => {
		expect(migrateRawVaultSettings({ managed: false })).toEqual({ agentVaultManagementEnabled: false });
	});

	it("maps an empty/legacy object with no recognized field to agentVaultManagementEnabled=false", () => {
		expect(migrateRawVaultSettings({})).toEqual({ agentVaultManagementEnabled: false });
	});

	it("preserves sibling fields while dropping the legacy keys", () => {
		expect(
			migrateRawVaultSettings({
				vaultMode: "managed",
				extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
				agentDatabaseAccessEnabled: true,
			}),
		).toEqual({
			agentVaultManagementEnabled: true,
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
			agentDatabaseAccessEnabled: true,
		});
	});

	it("passes a new-shape agentVaultManagementEnabled value through unchanged", () => {
		expect(migrateRawVaultSettings({ agentVaultManagementEnabled: true })).toEqual({
			agentVaultManagementEnabled: true,
		});
	});

	it("returns non-object input unchanged so schema validation can reject it", () => {
		expect(migrateRawVaultSettings(null)).toBeNull();
		expect(migrateRawVaultSettings("nope")).toBe("nope");
	});
});

describe("VaultSettingsStore.get", () => {
	it("defaults to everything off when no settings file exists", async () => {
		const settings = await store.get();
		expect(settings).toEqual({
			agentVaultManagementEnabled: false,
			extraPushRemotes: [],
			agentDatabaseAccessEnabled: false,
			agentStorageAccessEnabled: false,
		});
	});

	it("migrates a legacy vaultMode 'managed' file to agentVaultManagementEnabled=true on read", async () => {
		await writeRawSettings({ vaultMode: "managed" });
		expect(await store.get()).toEqual({
			agentVaultManagementEnabled: true,
			extraPushRemotes: [],
			agentDatabaseAccessEnabled: false,
			agentStorageAccessEnabled: false,
		});
	});

	it("migrates a legacy vaultMode 'on-demand' file to agentVaultManagementEnabled=false on read", async () => {
		await writeRawSettings({ vaultMode: "on-demand" });
		expect(await store.get()).toEqual({
			agentVaultManagementEnabled: false,
			extraPushRemotes: [],
			agentDatabaseAccessEnabled: false,
			agentStorageAccessEnabled: false,
		});
	});

	it("migrates the even-older managed=true boolean file on read", async () => {
		await writeRawSettings({ managed: true });
		expect(await store.get()).toEqual({
			agentVaultManagementEnabled: true,
			extraPushRemotes: [],
			agentDatabaseAccessEnabled: false,
			agentStorageAccessEnabled: false,
		});
	});

	it("reads back persisted extra push remotes", async () => {
		await writeRawSettings({
			agentVaultManagementEnabled: false,
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
		});
		expect(await store.get()).toEqual({
			agentVaultManagementEnabled: false,
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
			agentDatabaseAccessEnabled: false,
			agentStorageAccessEnabled: false,
		});
	});

	it("defaults agentDatabaseAccessEnabled to false for a legacy file that omits it", async () => {
		await writeRawSettings({ vaultMode: "managed", extraPushRemotes: [] });
		expect((await store.get()).agentDatabaseAccessEnabled).toBe(false);
	});

	it("reads back a persisted agentDatabaseAccessEnabled=true flag", async () => {
		await writeRawSettings({ agentVaultManagementEnabled: false, extraPushRemotes: [], agentDatabaseAccessEnabled: true });
		expect((await store.get()).agentDatabaseAccessEnabled).toBe(true);
	});
});

describe("VaultSettingsStore.set", () => {
	it("persists each agentVaultManagementEnabled value and reads it back", async () => {
		for (const agentVaultManagementEnabled of [true, false] as const) {
			const written = await store.set({
				agentVaultManagementEnabled,
				extraPushRemotes: [],
				agentDatabaseAccessEnabled: false,
				agentStorageAccessEnabled: false,
			});
			expect(written).toEqual({ agentVaultManagementEnabled, extraPushRemotes: [], agentDatabaseAccessEnabled: false, agentStorageAccessEnabled: false });

			const onDisk = JSON.parse(await readFile(settingsPath(), "utf8"));
			expect(onDisk).toEqual({ agentVaultManagementEnabled, extraPushRemotes: [], agentDatabaseAccessEnabled: false, agentStorageAccessEnabled: false });

			const reread = await new VaultSettingsStore(repoPath).get();
			expect(reread).toEqual({ agentVaultManagementEnabled, extraPushRemotes: [], agentDatabaseAccessEnabled: false, agentStorageAccessEnabled: false });
		}
	});
});

describe("VaultSettingsStore.update", () => {
	it("changes only agentVaultManagementEnabled and preserves the existing extraPushRemotes", async () => {
		await store.set({
			agentVaultManagementEnabled: false,
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
			agentDatabaseAccessEnabled: false,
			agentStorageAccessEnabled: false,
		});
		const updated = await store.update({ agentVaultManagementEnabled: true });
		expect(updated).toEqual({
			agentVaultManagementEnabled: true,
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
			agentDatabaseAccessEnabled: false,
			agentStorageAccessEnabled: false,
		});
		expect(await new VaultSettingsStore(repoPath).get()).toEqual(updated);
	});

	it("changes only extraPushRemotes and preserves agentVaultManagementEnabled", async () => {
		await store.set({ agentVaultManagementEnabled: true, extraPushRemotes: [], agentDatabaseAccessEnabled: false, agentStorageAccessEnabled: false });
		const updated = await store.update({
			extraPushRemotes: [{ name: "mirror", url: "https://github.com/o/r.git" }],
		});
		expect(updated).toEqual({
			agentVaultManagementEnabled: true,
			extraPushRemotes: [{ name: "mirror", url: "https://github.com/o/r.git" }],
			agentDatabaseAccessEnabled: false,
			agentStorageAccessEnabled: false,
		});
	});

	it("toggles only agentDatabaseAccessEnabled and preserves agentVaultManagementEnabled + extraPushRemotes", async () => {
		await store.set({
			agentVaultManagementEnabled: true,
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
			agentDatabaseAccessEnabled: false,
			agentStorageAccessEnabled: false,
		});
		const enabled = await store.update({ agentDatabaseAccessEnabled: true });
		expect(enabled).toEqual({
			agentVaultManagementEnabled: true,
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
			agentDatabaseAccessEnabled: true,
			agentStorageAccessEnabled: false,
		});
		expect(await new VaultSettingsStore(repoPath).get()).toEqual(enabled);

		const disabled = await store.update({ agentDatabaseAccessEnabled: false });
		expect(disabled.agentDatabaseAccessEnabled).toBe(false);
	});

	it("is a no-op that returns the current settings when given an empty patch", async () => {
		await store.set({ agentVaultManagementEnabled: true, extraPushRemotes: [], agentDatabaseAccessEnabled: true, agentStorageAccessEnabled: false });
		expect(await store.update({})).toEqual({
			agentVaultManagementEnabled: true,
			extraPushRemotes: [],
			agentDatabaseAccessEnabled: true,
			agentStorageAccessEnabled: false,
		});
	});
});
