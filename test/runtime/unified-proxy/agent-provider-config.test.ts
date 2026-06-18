import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../../utilities/temp-dir";

// Capture warnings emitted through the logging facade so the observability of
// invalid/corrupt on-disk data can be asserted.
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("../../../src/logging", () => ({
	createLogger: () => ({
		debug: () => {},
		info: () => {},
		warn: warnMock,
		error: () => {},
		child: () => ({ debug: () => {}, info: () => {}, warn: warnMock, error: () => {} }),
	}),
}));

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
		warnMock.mockClear();
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

	it("preserves the stored apiKey when an edit omits it", async () => {
		// The web client never receives the apiKey (it is redacted out of the
		// provider set it merges edits onto), so an edit that does not re-enter the
		// key must not wipe the stored one.
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "my-relay",
			model: "model-1",
			baseUrl: "https://relay.local",
			apiKey: "sk-relay",
		});
		// Edit: change the model + baseUrl, omit apiKey entirely.
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "my-relay",
			model: "model-2",
			baseUrl: "https://relay.example.com",
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude", "my-relay");
		expect(config!.model).toBe("model-2");
		expect(config!.baseUrl).toBe("https://relay.example.com");
		// The stored secret survives the edit.
		expect(config!.apiKey).toBe("sk-relay");
	});

	it("overwrites the apiKey when an edit provides a new one", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "my-relay",
			apiKey: "sk-old",
		});
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "my-relay",
			apiKey: "sk-new",
		});
		resetAgentProviderConfigCache();

		expect(getAgentProviderConfig("claude", "my-relay")!.apiKey).toBe("sk-new");
	});

	it("scopes apiKey preservation to the edited provider only", async () => {
		// Default + non-default, each with its own key.
		await saveAgentProvider("claude", { agentId: "claude", provider: "anthropic", apiKey: "sk-a" });
		await saveAgentProvider("claude", { agentId: "claude", provider: "my-relay", apiKey: "sk-b" });
		// Edit the non-default provider, omitting its key.
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "my-relay",
			model: "relay-model",
		});
		resetAgentProviderConfigCache();

		// The edited provider keeps its own key (not the default's).
		expect(getAgentProviderConfig("claude", "my-relay")!.apiKey).toBe("sk-b");
		// The default provider is untouched.
		expect(getAgentProviderConfig("claude", "anthropic")!.apiKey).toBe("sk-a");
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

	it("accepts the official-login sentinel as a default and survives a read round-trip", async () => {
		await saveAgentProvider("claude", { agentId: "claude", provider: "anthropic" });
		await saveAgentProvider("claude", { agentId: "claude", provider: "my-relay" });
		// Switch the agent's default to official login (no custom provider matches it).
		await setDefaultAgentProvider("claude", "official");
		resetAgentProviderConfigCache();

		const set = getAgentProviderSet("claude");
		// Custom providers are untouched; the default is the sentinel and reconcileSet
		// must not overwrite it with providers[0].
		expect(set!.providers).toHaveLength(2);
		expect(set!.defaultProviderId).toBe("official");
		// No provider record matches the sentinel, so the default config resolves to null.
		expect(getAgentProviderConfig("claude")).toBeNull();
	});

	it("rejects saving a custom provider whose name shadows the official-login id", async () => {
		await expect(saveAgentProvider("claude", { agentId: "claude", provider: "Official" })).rejects.toThrow(
			/reserved/i,
		);
		resetAgentProviderConfigCache();
		// Nothing was persisted for the agent.
		expect(getAgentProviderSet("claude")).toBeNull();
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

	it("collapses a per-agent provider to its single protocol, dropping never-used ones", async () => {
		// codex only ever speaks openai — the second protocol is dead config.
		await saveAgentProvider("codex", {
			agentId: "codex",
			provider: "my-relay",
			protocols: [
				{ protocol: "openai", baseUrl: "https://o.example.com" },
				{ protocol: "anthropic", baseUrl: "https://a.example.com" },
			],
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("codex");
		expect(config!.protocols).toEqual([{ protocol: "openai", baseUrl: "https://o.example.com" }]);
	});

	it("folds a legacy scalar baseUrl into protocols and never persists it (read-time mirror only)", async () => {
		await saveAgentProvider("codex", {
			agentId: "codex",
			provider: "openai",
			baseUrl: "https://api.example.com",
		});
		resetAgentProviderConfigCache();

		// On disk: the endpoint lives only in `protocols[]`, not a top-level baseUrl.
		const raw = JSON.parse(
			readFileSync((globalThis as { __testAgentProvidersPath?: string }).__testAgentProvidersPath!, "utf8"),
		);
		const stored = raw.agents.codex.providers[0];
		expect(stored.protocols).toEqual([{ protocol: "openai", baseUrl: "https://api.example.com" }]);
		expect(stored.baseUrl).toBeUndefined();

		// On read: baseUrl is re-derived from protocols[0] for backward-compat readers.
		const config = getAgentProviderConfig("codex");
		expect(config!.baseUrl).toBe("https://api.example.com");
		expect(config!.protocols).toEqual([{ protocol: "openai", baseUrl: "https://api.example.com" }]);
	});

	it("migrates a legacy single-baseUrl config (no protocols) on read", async () => {
		// Hand-write a pre-protocols on-disk config.
		const path = (globalThis as { __testAgentProvidersPath?: string }).__testAgentProvidersPath!;
		writeFileSync(
			path,
			JSON.stringify({
				agents: {
					claude: {
						providers: [{ provider: "anthropic", baseUrl: "https://relay.local" }],
						defaultProviderId: "anthropic",
					},
				},
			}),
		);
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude");
		expect(config!.protocols).toEqual([{ protocol: "anthropic", baseUrl: "https://relay.local" }]);
		expect(config!.baseUrl).toBe("https://relay.local");
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

	it("stores anthropic settings (apiKeyField + defaultModels) round-trip", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
			anthropic: {
				apiKeyField: "api_key",
				defaultModels: { haiku: "h-model", sonnet: "s-model", opus: "o-model" },
			},
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude");
		expect(config!.anthropic).toEqual({
			apiKeyField: "api_key",
			defaultModels: { haiku: "h-model", sonnet: "s-model", opus: "o-model" },
		});
	});

	it("trims and drops empty anthropic default model overrides on save", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
			anthropic: { apiKeyField: "auth_token", defaultModels: { haiku: "  h-model  ", sonnet: "", opus: "   " } },
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude");
		expect(config!.anthropic).toEqual({ apiKeyField: "auth_token", defaultModels: { haiku: "h-model" } });
	});

	it("migrates legacy flat apiKeyField/anthropicDefaultModels into the anthropic namespace on read", async () => {
		const path = join(temp.path, "agent_providers.json");
		writeFileSync(
			path,
			JSON.stringify({
				agents: {
					claude: {
						agentId: "claude",
						provider: "anthropic",
						apiKeyField: "api_key",
						anthropicDefaultModels: { sonnet: "legacy-sonnet" },
					},
				},
			}),
		);
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("claude");
		expect(config!.anthropic).toEqual({ apiKeyField: "api_key", defaultModels: { sonnet: "legacy-sonnet" } });
		// The flat legacy fields are not surfaced on the in-memory config.
		const raw = config as unknown as Record<string, unknown>;
		expect(raw.apiKeyField).toBeUndefined();
		expect(raw.anthropicDefaultModels).toBeUndefined();
	});

	it("persists the full models list and modelsSourceUrl round-trip", async () => {
		await saveAgentProvider("pi", {
			agentId: "pi",
			provider: "openai",
			models: ["gpt-5", "gpt-5-mini", "o3"],
			model: "gpt-5-mini",
			modelsSourceUrl: "https://api.example.com/v1/models",
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("pi");
		expect(config!.models).toEqual(["gpt-5", "gpt-5-mini", "o3"]);
		expect(config!.model).toBe("gpt-5-mini");
		expect(config!.modelsSourceUrl).toBe("https://api.example.com/v1/models");
	});

	it("trims and de-duplicates models, dropping empties", async () => {
		await saveAgentProvider("pi", {
			agentId: "pi",
			provider: "openai",
			models: ["  gpt-5  ", "gpt-5", "", "  ", "o3"],
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("pi");
		expect(config!.models).toEqual(["gpt-5", "o3"]);
	});

	it("repoints the default model to the first listed model when it is not in the list", async () => {
		await saveAgentProvider("pi", {
			agentId: "pi",
			provider: "openai",
			models: ["gpt-5", "o3"],
			model: "stale-model",
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("pi");
		expect(config!.model).toBe("gpt-5");
	});

	it("defaults the model to the first listed model when none is given", async () => {
		await saveAgentProvider("pi", {
			agentId: "pi",
			provider: "openai",
			models: ["gpt-5", "o3"],
		});
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("pi");
		expect(config!.model).toBe("gpt-5");
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

	it("does not warn for a valid on-disk config", () => {
		const path = join(temp.path, "agent_providers.json");
		writeFileSync(
			path,
			JSON.stringify({
				agents: {
					pi: {
						agentId: "pi",
						provider: "openai",
						model: "gpt-5",
						reasoning: { effort: "high" },
					},
				},
			}),
		);
		resetAgentProviderConfigCache();

		expect(getAgentProviderConfig("pi")!.reasoning).toEqual({ effort: "high" });
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("drops an invalid reasoning.effort enum value, keeps the rest, and warns with agentId", () => {
		const path = join(temp.path, "agent_providers.json");
		writeFileSync(
			path,
			JSON.stringify({
				agents: {
					pi: {
						agentId: "pi",
						provider: "openai",
						model: "gpt-5",
						reasoning: { enabled: true, effort: "ultra", budgetTokens: 1000 },
					},
				},
			}),
		);
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("pi");
		// Valid sibling fields survive the bad enum value.
		expect(config!.provider).toBe("openai");
		expect(config!.model).toBe("gpt-5");
		// The malformed reasoning object is dropped rather than trusted.
		expect(config!.reasoning).toBeUndefined();
		// And the loss is observable, scoped to the agent.
		expect(warnMock).toHaveBeenCalled();
		const [, fields] = warnMock.mock.calls[0] as [string, { agentId: string }];
		expect(fields.agentId).toBe("pi");
	});

	it("drops a wrong-typed scalar field, keeps the rest, and warns", () => {
		const path = join(temp.path, "agent_providers.json");
		writeFileSync(
			path,
			JSON.stringify({
				agents: {
					pi: {
						agentId: "pi",
						provider: "openai",
						model: "gpt-5",
						timeout: "not-a-number",
					},
				},
			}),
		);
		resetAgentProviderConfigCache();

		const config = getAgentProviderConfig("pi");
		expect(config!.provider).toBe("openai");
		expect(config!.timeout).toBeUndefined();
		expect(warnMock).toHaveBeenCalled();
	});

	it("warns when the store file is corrupt JSON", () => {
		const path = join(temp.path, "agent_providers.json");
		writeFileSync(path, "not valid json{{{");
		resetAgentProviderConfigCache();

		expect(getAgentProviderConfig("pi")).toBeNull();
		expect(warnMock).toHaveBeenCalled();
	});
});
