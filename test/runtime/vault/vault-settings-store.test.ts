import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VaultSettingsStore } from "../../../src/vault/vault-settings-store";

let repoPath: string;
let store: VaultSettingsStore;

const settingsPath = () => join(repoPath, ".kanban", "files", "settings.json");

beforeEach(async () => {
	repoPath = await mkdtemp(join(tmpdir(), "kanban-vault-settings-store-"));
	store = new VaultSettingsStore(repoPath);
});

afterEach(async () => {
	await rm(repoPath, { recursive: true, force: true });
});

describe("VaultSettingsStore.get", () => {
	it("defaults to unmanaged when no settings file exists", async () => {
		const settings = await store.get();
		expect(settings).toEqual({ managed: false });
	});
});

describe("VaultSettingsStore.set", () => {
	it("persists managed=true and reads it back", async () => {
		const written = await store.set({ managed: true });
		expect(written).toEqual({ managed: true });

		const onDisk = JSON.parse(await readFile(settingsPath(), "utf8"));
		expect(onDisk).toEqual({ managed: true });

		const reread = await new VaultSettingsStore(repoPath).get();
		expect(reread).toEqual({ managed: true });
	});

	it("can toggle managed back to false", async () => {
		await store.set({ managed: true });
		const written = await store.set({ managed: false });
		expect(written).toEqual({ managed: false });
		expect(await store.get()).toEqual({ managed: false });
	});
});
