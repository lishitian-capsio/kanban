import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../../utilities/temp-dir";

// Mock locked-file-system so writes are synchronous and don't need real locking.
vi.mock("../../../src/fs/locked-file-system", () => ({
	lockedFileSystem: {
		writeJsonFileAtomic: vi.fn(async (_path: string, data: unknown) => {
			// Delegate to the real fs for test verification.
			const target = (globalThis as { __testAgentProvidersPath?: string }).__testAgentProvidersPath;
			if (target) {
				const dir = target.substring(0, target.lastIndexOf("/"));
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				writeFileSync(target, JSON.stringify(data, null, 2));
			}
		}),
	},
}));

import {
	deleteAgentProvider,
	getAgentProviderConfig,
	getAgentProviderSet,
	getAllAgentProviderConfigs,
	getAllAgentProviderSets,
	resetAgentProviderConfigCache,
	saveAgentProvider,
	setDefaultAgentProvider,
} from "../../../src/agent-sdk/kanban/agent-provider-config";

describe("agent-provider-config", () => {
	let temp: ReturnType<typeof createTempDir>;
	let originalEnv: string | undefined;

	beforeEach(() => {
		temp = createTempDir("kanban-agent-providers-");
		const path = join(temp.path, "agent_providers.json");
		(globalThis as { __testAgentProvidersPath?: string }).__testAgentProvidersPath = path;
		originalEnv = process.env.KANBAN_AGENT_PROVIDERS_PATH;
		process.env.KANBAN_AGENT_PROVIDERS_PATH = path;
		resetAgentProviderConfigCache();
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.KANBAN_AGENT_PROVIDERS_PATH;
		} else {
			process.env.KANBAN_AGENT_PROVIDERS_PATH = originalEnv;
		}
		(globalThis as { __testAgentProvidersPath?: string }).__testAgentProvidersPath = undefined;
		resetAgentProviderConfigCache();
		temp.cleanup();
	});

	it("returns null for an agent that has not been configured", () => {
		const config = getAgentProviderConfig("claude");
		expect(config).toBeNull();
	});

	it("returns null for an unknown agent", () => {
		const config = getAgentProviderConfig("unknown-agent");
		expect(config).toBeNull();
	});

	it("normalizes agent ids to lowercase", async () => {
		await saveAgentProvider("CLAUDE", { agentId: "CLAUDE", provider: "anthropic", model: "claude-3" });
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude");
		expect(config).not.toBeNull();
		expect(config!.agentId).toBe("claude");
		expect(config!.provider).toBe("anthropic");
	});

	it("saves and loads a config round-trip", async () => {
		await saveAgentProvider("codex", {
			agentId: "codex",
			provider: "openai",
			model: "gpt-5",
			apiKey: "sk-test",
			baseUrl: "https://api.example.com",
		});
		resetAgentProviderConfigCache();

		const loaded = getAgentProviderConfig("codex");
		expect(loaded).not.toBeNull();
		expect(loaded!.provider).toBe("openai");
		expect(loaded!.model).toBe("gpt-5");
		expect(loaded!.apiKey).toBe("sk-test");
		expect(loaded!.baseUrl).toBe("https://api.example.com");
	});

	it("overwrites a provider with the same name on save (and keeps the default)", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
			model: "claude-3",
		});
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
			model: "claude-4",
			baseUrl: "https://proxy.local",
		});
		resetAgentProviderConfigCache();

		const set = getAgentProviderSet("claude");
		expect(set!.providers).toHaveLength(1);
		const config = getAgentProviderConfig("claude");
		expect(config!.provider).toBe("anthropic");
		expect(config!.model).toBe("claude-4");
		expect(config!.baseUrl).toBe("https://proxy.local");
	});

	it("registers multiple named providers for one agent and selects by providerId", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			apiKey: "sk-a",
		});
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "my-relay",
			baseUrl: "https://relay.local",
			apiKey: "sk-b",
		});
		resetAgentProviderConfigCache();

		const set = getAgentProviderSet("claude");
		expect(set!.providers).toHaveLength(2);
		// First registered provider remains the default.
		expect(set!.defaultProviderId).toBe("anthropic");
		expect(getAgentProviderConfig("claude")!.provider).toBe("anthropic");

		// Each provider is independently addressable by providerId.
		expect(getAgentProviderConfig("claude", "anthropic")!.baseUrl).toBe("https://api.anthropic.com");
		expect(getAgentProviderConfig("claude", "my-relay")!.baseUrl).toBe("https://relay.local");
		// Unknown providerId resolves to null (no silent default).
		expect(getAgentProviderConfig("claude", "nope")).toBeNull();
	});

	it("changes the default provider via setDefaultAgentProvider", async () => {
		await saveAgentProvider("claude", { agentId: "claude", provider: "anthropic" });
		await saveAgentProvider("claude", { agentId: "claude", provider: "my-relay" });
		await setDefaultAgentProvider("claude", "my-relay");
		resetAgentProviderConfigCache();

		expect(getAgentProviderSet("claude")!.defaultProviderId).toBe("my-relay");
		expect(getAgentProviderConfig("claude")!.provider).toBe("my-relay");
	});

	it("ignores setDefaultAgentProvider for an unknown providerId", async () => {
		await saveAgentProvider("claude", { agentId: "claude", provider: "anthropic" });
		await setDefaultAgentProvider("claude", "ghost");
		resetAgentProviderConfigCache();
		expect(getAgentProviderSet("claude")!.defaultProviderId).toBe("anthropic");
	});

	it("deletes a single provider and re-points the default", async () => {
		await saveAgentProvider("claude", { agentId: "claude", provider: "anthropic" });
		await saveAgentProvider("claude", { agentId: "claude", provider: "my-relay" });
		resetAgentProviderConfigCache();
		expect(getAgentProviderSet("claude")!.defaultProviderId).toBe("anthropic");

		await deleteAgentProvider("claude", "anthropic");
		resetAgentProviderConfigCache();
		const set = getAgentProviderSet("claude");
		expect(set!.providers).toHaveLength(1);
		expect(set!.providers[0].provider).toBe("my-relay");
		// Default re-points to the surviving provider.
		expect(set!.defaultProviderId).toBe("my-relay");
	});

	it("deletes the whole agent set when no providerId is given", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
			model: "claude-3",
		});
		resetAgentProviderConfigCache();
		expect(getAgentProviderConfig("claude")).not.toBeNull();

		await deleteAgentProvider("claude");
		resetAgentProviderConfigCache();
		expect(getAgentProviderConfig("claude")).toBeNull();
		expect(getAgentProviderSet("claude")).toBeNull();
	});

	it("deleting the last remaining provider removes the agent set", async () => {
		await saveAgentProvider("claude", { agentId: "claude", provider: "anthropic" });
		resetAgentProviderConfigCache();
		await deleteAgentProvider("claude", "anthropic");
		resetAgentProviderConfigCache();
		expect(getAgentProviderSet("claude")).toBeNull();
	});

	it("migrates a legacy single-config on-disk shape into a one-provider set", async () => {
		// Write the pre-multi-provider on-disk shape directly.
		const path = join(temp.path, "agent_providers.json");
		writeFileSync(
			path,
			JSON.stringify({
				agents: {
					claude: { agentId: "claude", provider: "anthropic", model: "claude-3", apiKey: "sk-legacy" },
				},
			}),
		);
		resetAgentProviderConfigCache();

		const set = getAgentProviderSet("claude");
		expect(set!.providers).toHaveLength(1);
		expect(set!.defaultProviderId).toBe("anthropic");
		const config = getAgentProviderConfig("claude");
		expect(config!.provider).toBe("anthropic");
		expect(config!.apiKey).toBe("sk-legacy");
	});

	it("lists all configured agent configs", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
		});
		await saveAgentProvider("codex", {
			agentId: "codex",
			provider: "openai",
		});
		resetAgentProviderConfigCache();

		const all = getAllAgentProviderConfigs();
		expect(Object.keys(all)).toContain("claude");
		expect(Object.keys(all)).toContain("codex");
		expect(all["claude"].provider).toBe("anthropic");
		expect(all["codex"].provider).toBe("openai");

		const sets = getAllAgentProviderSets();
		expect(sets["claude"].providers).toHaveLength(1);
		expect(sets["claude"].defaultProviderId).toBe("anthropic");
		expect(sets["codex"].providers).toHaveLength(1);
	});

	it("handles a corrupted JSON file gracefully", () => {
		const path = join(temp.path, "agent_providers.json");
		writeFileSync(path, "not valid json{{{");
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude");
		// Should fall back to null (no config).
		expect(config).toBeNull();
	});

	it("saves and loads protocols with per-protocol baseUrl", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
			protocols: [{ protocol: "anthropic", baseUrl: "https://anthropic.example.com" }],
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude");
		expect(config!.protocols).toEqual([{ protocol: "anthropic", baseUrl: "https://anthropic.example.com" }]);
	});

	it("trims whitespace from string fields on save", async () => {
		await saveAgentProvider("pi", {
			agentId: "pi",
			provider: "  openai  ",
			model: "  gpt-5  ",
			apiKey: "  sk-test  ",
			baseUrl: "  https://api.example.com  ",
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("pi");
		expect(config!.provider).toBe("openai");
		expect(config!.model).toBe("gpt-5");
		expect(config!.apiKey).toBe("sk-test");
		expect(config!.baseUrl).toBe("https://api.example.com");
	});

	it("stores apiKeyField and anthropicDefaultModels round-trip", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
			apiKeyField: "api_key",
			anthropicDefaultModels: { haiku: "h-model", sonnet: "s-model", opus: "o-model" },
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude");
		expect(config!.apiKeyField).toBe("api_key");
		expect(config!.anthropicDefaultModels).toEqual({ haiku: "h-model", sonnet: "s-model", opus: "o-model" });
	});

	it("stores reasoning settings", async () => {
		await saveAgentProvider("pi", {
			agentId: "pi",
			provider: "openai",
			reasoning: { enabled: true, effort: "high", budgetTokens: 1000 },
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("pi");
		expect(config!.reasoning).toEqual({ enabled: true, effort: "high", budgetTokens: 1000 });
	});
});
