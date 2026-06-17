import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	buildCommittedProviderFromProviderSettings,
	type CommittedProviderRecord,
	type CommittedProvidersData,
	getSelectedCommittedProvider,
	readCommittedProviders,
	writeCommittedProviders,
} from "../../src/state/committed-provider-store";
import { createTempDir } from "../utilities/temp-dir";

function record(providerId: string, overrides: Partial<CommittedProviderRecord> = {}): CommittedProviderRecord {
	return {
		providerId,
		agentId: "pi",
		scope: "workspace",
		modelId: "claude-sonnet-4",
		baseUrl: null,
		reasoningEffort: null,
		region: null,
		gcpProjectId: null,
		gcpRegion: null,
		...overrides,
	};
}

async function withTempDir<T>(run: (paths: { providersDir: string; selectionPath: string }) => Promise<T>): Promise<T> {
	const { path, cleanup } = createTempDir("committed-provider-store-");
	try {
		return await run({
			providersDir: join(path, "agent-providers"),
			selectionPath: join(path, "agent-provider-selection.json"),
		});
	} finally {
		cleanup();
	}
}

describe("committed-provider-store", () => {
	it("returns empty data when nothing is on disk", async () => {
		await withTempDir(async ({ providersDir, selectionPath }) => {
			const data = await readCommittedProviders(providersDir, selectionPath);
			expect(data).toEqual({ providers: [], selectedByAgent: {} });
		});
	});

	it("round-trips providers (sharded by providerId) and the selection", async () => {
		await withTempDir(async ({ providersDir, selectionPath }) => {
			const next: CommittedProvidersData = {
				providers: [record("anthropic"), record("ollama", { modelId: "qwen" })],
				selectedByAgent: { pi: "anthropic" },
			};
			await writeCommittedProviders(providersDir, selectionPath, next);

			const files = (await readdir(providersDir)).sort();
			expect(files).toEqual(["anthropic.json", "ollama.json"]);

			const read = await readCommittedProviders(providersDir, selectionPath);
			expect(read.providers.map((p) => p.providerId).sort()).toEqual(["anthropic", "ollama"]);
			expect(read.selectedByAgent).toEqual({ pi: "anthropic" });
		});
	});

	it("deletes a provider shard whose id is no longer present", async () => {
		await withTempDir(async ({ providersDir, selectionPath }) => {
			await writeCommittedProviders(providersDir, selectionPath, {
				providers: [record("anthropic"), record("ollama")],
				selectedByAgent: {},
			});
			await writeCommittedProviders(providersDir, selectionPath, {
				providers: [record("anthropic")],
				selectedByAgent: {},
			});

			const files = (await readdir(providersDir)).sort();
			expect(files).toEqual(["anthropic.json"]);
		});
	});

	describe("getSelectedCommittedProvider", () => {
		it("resolves the selected provider for an agent", () => {
			const data: CommittedProvidersData = {
				providers: [record("anthropic"), record("openai")],
				selectedByAgent: { pi: "openai" },
			};
			expect(getSelectedCommittedProvider(data, "pi")?.providerId).toBe("openai");
		});

		it("returns null when nothing is selected or the selection dangles", () => {
			const data: CommittedProvidersData = {
				providers: [record("anthropic")],
				selectedByAgent: { pi: "missing" },
			};
			expect(getSelectedCommittedProvider(data, "pi")).toBeNull();
			expect(getSelectedCommittedProvider({ providers: [], selectedByAgent: {} }, "pi")).toBeNull();
		});
	});

	describe("buildCommittedProviderFromProviderSettings", () => {
		it("maps non-secret provider settings into a committed record keyed by providerId", () => {
			const provider = buildCommittedProviderFromProviderSettings(
				{
					agentId: "pi",
					provider: "OpenAI",
					model: "gpt-5",
					baseUrl: "https://example.test/v1",
					apiKey: "sk-secret",
					reasoning: { effort: "high" },
					region: "us-east-1",
					gcp: { projectId: "proj", region: "us-central1" },
				},
				"pi",
			);
			expect(provider).toEqual({
				providerId: "openai",
				agentId: "pi",
				scope: "workspace",
				modelId: "gpt-5",
				baseUrl: "https://example.test/v1",
				reasoningEffort: "high",
				region: "us-east-1",
				gcpProjectId: "proj",
				gcpRegion: "us-central1",
			});
		});

		it("never copies the secret apiKey into the committed record", () => {
			const provider = buildCommittedProviderFromProviderSettings(
				{ agentId: "pi", provider: "anthropic", apiKey: "sk-secret" },
				"pi",
			);
			expect(JSON.stringify(provider)).not.toContain("sk-secret");
		});

		it("returns null when there are no settings or no provider", () => {
			expect(buildCommittedProviderFromProviderSettings(null, "pi")).toBeNull();
			expect(buildCommittedProviderFromProviderSettings({ agentId: "pi", provider: "  " }, "pi")).toBeNull();
		});

		it("drops an unknown reasoning effort to null", () => {
			const provider = buildCommittedProviderFromProviderSettings(
				{ agentId: "pi", provider: "anthropic", reasoning: { effort: "bogus" } },
				"pi",
			);
			expect(provider?.reasoningEffort).toBeNull();
		});
	});
});
