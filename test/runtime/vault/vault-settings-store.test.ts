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
	it("maps legacy managed=true to vaultMode 'managed'", () => {
		expect(migrateRawVaultSettings({ managed: true })).toEqual({ vaultMode: "managed" });
	});

	it("maps legacy managed=false to vaultMode 'off'", () => {
		expect(migrateRawVaultSettings({ managed: false })).toEqual({ vaultMode: "off" });
	});

	it("maps an empty/legacy object with no managed field to vaultMode 'off'", () => {
		expect(migrateRawVaultSettings({})).toEqual({ vaultMode: "off" });
	});

	it("passes a new-shape vaultMode value through unchanged", () => {
		expect(migrateRawVaultSettings({ vaultMode: "on-demand" })).toEqual({ vaultMode: "on-demand" });
	});

	it("returns non-object input unchanged so schema validation can reject it", () => {
		expect(migrateRawVaultSettings(null)).toBeNull();
		expect(migrateRawVaultSettings("nope")).toBe("nope");
	});
});

describe("VaultSettingsStore.get", () => {
	it("defaults to vaultMode 'off' and no extra push remotes when no settings file exists", async () => {
		const settings = await store.get();
		expect(settings).toEqual({ vaultMode: "off", extraPushRemotes: [] });
	});

	it("migrates a legacy managed=true file to vaultMode 'managed' on read", async () => {
		await writeRawSettings({ managed: true });
		expect(await store.get()).toEqual({ vaultMode: "managed", extraPushRemotes: [] });
	});

	it("migrates a legacy managed=false file to vaultMode 'off' on read", async () => {
		await writeRawSettings({ managed: false });
		expect(await store.get()).toEqual({ vaultMode: "off", extraPushRemotes: [] });
	});

	it("reads back persisted extra push remotes", async () => {
		await writeRawSettings({
			vaultMode: "off",
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
		});
		expect(await store.get()).toEqual({
			vaultMode: "off",
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
		});
	});
});

describe("VaultSettingsStore.set", () => {
	it("persists each vaultMode tier and reads it back", async () => {
		for (const vaultMode of ["off", "cli-only", "on-demand", "managed"] as const) {
			const written = await store.set({ vaultMode, extraPushRemotes: [] });
			expect(written).toEqual({ vaultMode, extraPushRemotes: [] });

			const onDisk = JSON.parse(await readFile(settingsPath(), "utf8"));
			expect(onDisk).toEqual({ vaultMode, extraPushRemotes: [] });

			const reread = await new VaultSettingsStore(repoPath).get();
			expect(reread).toEqual({ vaultMode, extraPushRemotes: [] });
		}
	});

	it("can move the mode back down to 'off'", async () => {
		await store.set({ vaultMode: "managed", extraPushRemotes: [] });
		const written = await store.set({ vaultMode: "off", extraPushRemotes: [] });
		expect(written).toEqual({ vaultMode: "off", extraPushRemotes: [] });
		expect(await store.get()).toEqual({ vaultMode: "off", extraPushRemotes: [] });
	});
});

describe("VaultSettingsStore.update", () => {
	it("changes only vaultMode and preserves the existing extraPushRemotes", async () => {
		await store.set({
			vaultMode: "off",
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
		});
		const updated = await store.update({ vaultMode: "managed" });
		expect(updated).toEqual({
			vaultMode: "managed",
			extraPushRemotes: [{ name: "gitee", url: "https://gitee.com/o/r.git" }],
		});
		expect(await new VaultSettingsStore(repoPath).get()).toEqual(updated);
	});

	it("changes only extraPushRemotes and preserves the existing vaultMode", async () => {
		await store.set({ vaultMode: "on-demand", extraPushRemotes: [] });
		const updated = await store.update({
			extraPushRemotes: [{ name: "mirror", url: "https://github.com/o/r.git" }],
		});
		expect(updated).toEqual({
			vaultMode: "on-demand",
			extraPushRemotes: [{ name: "mirror", url: "https://github.com/o/r.git" }],
		});
	});

	it("is a no-op that returns the current settings when given an empty patch", async () => {
		await store.set({ vaultMode: "cli-only", extraPushRemotes: [] });
		expect(await store.update({})).toEqual({ vaultMode: "cli-only", extraPushRemotes: [] });
	});
});
