import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeAgentProfileRecord, RuntimeAgentProfilesData } from "../../src/core/api-contract";
import {
	buildDefaultProfileFromProviderSettings,
	readAgentProfilesData,
	writeAgentProfilesData,
} from "../../src/state/agent-profile-store";
import { createTempDir } from "../utilities/temp-dir";

function record(
	id: string,
	name: string,
	overrides: Partial<RuntimeAgentProfileRecord> = {},
): RuntimeAgentProfileRecord {
	return {
		id,
		name,
		agentId: "pi",
		providerId: "anthropic",
		modelId: "claude-sonnet-4",
		baseUrl: null,
		reasoningEffort: null,
		region: null,
		gcpProjectId: null,
		gcpRegion: null,
		...overrides,
	};
}

async function withTempDir<T>(run: (paths: { profilesDir: string; selectionPath: string }) => Promise<T>): Promise<T> {
	const { path, cleanup } = createTempDir("agent-profile-store-");
	try {
		return await run({
			profilesDir: join(path, "agent-profiles"),
			selectionPath: join(path, "agent-profile-selection.json"),
		});
	} finally {
		cleanup();
	}
}

describe("agent-profile-store", () => {
	it("returns empty data when nothing is on disk", async () => {
		await withTempDir(async ({ profilesDir, selectionPath }) => {
			const data = await readAgentProfilesData(profilesDir, selectionPath);
			expect(data).toEqual({ profiles: [], selectedByAgent: {} });
		});
	});

	it("round-trips profiles (sharded by id) and the selection", async () => {
		await withTempDir(async ({ profilesDir, selectionPath }) => {
			const next: RuntimeAgentProfilesData = {
				profiles: [record("p1", "Sonnet"), record("p2", "Local", { providerId: "ollama" })],
				selectedByAgent: { pi: "p1" },
			};
			await writeAgentProfilesData(profilesDir, selectionPath, next);

			const files = (await readdir(profilesDir)).sort();
			expect(files).toEqual(["p1.json", "p2.json"]);

			const read = await readAgentProfilesData(profilesDir, selectionPath);
			expect(read.profiles.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
			expect(read.selectedByAgent).toEqual({ pi: "p1" });
		});
	});

	describe("buildDefaultProfileFromProviderSettings", () => {
		it("maps non-secret provider settings into a default profile record", () => {
			const profile = buildDefaultProfileFromProviderSettings(
				{
					agentId: "pi",
					provider: "openai",
					model: "gpt-5",
					baseUrl: "https://example.test/v1",
					apiKey: "sk-secret",
					reasoning: { effort: "high" },
					region: "us-east-1",
					gcp: { projectId: "proj", region: "us-central1" },
				},
				{ id: "default-pi", name: "Default", agentId: "pi" },
			);
			expect(profile).toEqual({
				id: "default-pi",
				name: "Default",
				agentId: "pi",
				providerId: "openai",
				modelId: "gpt-5",
				baseUrl: "https://example.test/v1",
				reasoningEffort: "high",
				region: "us-east-1",
				gcpProjectId: "proj",
				gcpRegion: "us-central1",
			});
		});

		it("never copies the secret apiKey into the committed record", () => {
			const profile = buildDefaultProfileFromProviderSettings(
				{ agentId: "pi", provider: "anthropic", apiKey: "sk-secret" },
				{ id: "x", name: "X", agentId: "pi" },
			);
			expect(JSON.stringify(profile)).not.toContain("sk-secret");
		});

		it("returns null when there are no settings or no provider", () => {
			expect(buildDefaultProfileFromProviderSettings(null, { id: "x", name: "X", agentId: "pi" })).toBeNull();
			expect(
				buildDefaultProfileFromProviderSettings({ agentId: "pi", provider: "  " }, { id: "x", name: "X", agentId: "pi" }),
			).toBeNull();
		});
	});

	it("deletes a profile shard whose id is no longer present", async () => {
		await withTempDir(async ({ profilesDir, selectionPath }) => {
			await writeAgentProfilesData(profilesDir, selectionPath, {
				profiles: [record("p1", "Sonnet"), record("p2", "Local")],
				selectedByAgent: {},
			});
			await writeAgentProfilesData(profilesDir, selectionPath, {
				profiles: [record("p1", "Sonnet")],
				selectedByAgent: {},
			});

			const files = (await readdir(profilesDir)).sort();
			expect(files).toEqual(["p1.json"]);
		});
	});
});
