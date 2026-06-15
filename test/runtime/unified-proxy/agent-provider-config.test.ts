import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
	getAgentProviderConfig,
	saveAgentProvider,
	deleteAgentProvider,
	getAllAgentProviderConfigs,
	resetAgentProviderConfigCache,
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

	it("overwrites an existing config on save", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
			model: "claude-3",
		});
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "custom-proxy",
			model: "claude-4",
			baseUrl: "https://proxy.local",
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude");
		expect(config!.provider).toBe("custom-proxy");
		expect(config!.model).toBe("claude-4");
		expect(config!.baseUrl).toBe("https://proxy.local");
	});

	it("deletes an agent config", async () => {
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
			protocols: [
				{ protocol: "anthropic", baseUrl: "https://anthropic.example.com" },
			],
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude");
		expect(config!.protocols).toEqual([
			{ protocol: "anthropic", baseUrl: "https://anthropic.example.com" },
		]);
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
