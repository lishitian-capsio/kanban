import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProviderConfig } from "../../../src/agent-sdk/kanban/agent-provider-config";

// Mock the machine-home provider store. The resolver's job is selection logic;
// the store read is an injected dependency we control here. provider-protocol is
// intentionally NOT mocked — its official-login + compatibility helpers are real.
const storeMocks = vi.hoisted(() => ({
	getAgentProviderConfig: vi.fn(),
	getAgentProviderSet: vi.fn(),
}));

vi.mock("../../../src/agent-sdk/kanban/agent-provider-config", () => ({
	getAgentProviderConfig: storeMocks.getAgentProviderConfig,
	getAgentProviderSet: storeMocks.getAgentProviderSet,
}));

import { resolveAgentProvider } from "../../../src/agent-sdk/kanban/agent-provider-resolver";

function config(partial: Partial<AgentProviderConfig> & { agentId: string }): AgentProviderConfig {
	return partial as AgentProviderConfig;
}

describe("resolveAgentProvider", () => {
	beforeEach(() => {
		storeMocks.getAgentProviderConfig.mockReset();
		storeMocks.getAgentProviderConfig.mockReturnValue(null);
		storeMocks.getAgentProviderSet.mockReset();
		storeMocks.getAgentProviderSet.mockReturnValue(null);
	});

	describe("precedence (override > committed > machine-home > nothing)", () => {
		it("prefers the card override over the committed provider", () => {
			const result = resolveAgentProvider({
				agentId: "pi",
				providerIdOverride: "openai",
				modelIdOverride: "gpt-x",
				committedProvider: { providerId: "anthropic", modelId: "claude-x" },
			});
			expect(result).toMatchObject({ kind: "provider", providerId: "openai", modelId: "gpt-x" });
		});

		it("uses the committed provider when no override is given", () => {
			const result = resolveAgentProvider({
				agentId: "pi",
				committedProvider: { providerId: "anthropic", modelId: "claude-x", reasoningEffort: "high" },
			});
			expect(result).toMatchObject({
				kind: "provider",
				providerId: "anthropic",
				modelId: "claude-x",
				reasoningEffort: "high",
			});
		});

		it("fills missing non-secret fields from the machine-home config for the selected provider", () => {
			storeMocks.getAgentProviderConfig.mockImplementation((_agentId: string, providerId?: string) =>
				providerId === "my-relay"
					? config({ agentId: "pi", provider: "my-relay", model: "relay-model", baseUrl: "https://relay" })
					: null,
			);
			const result = resolveAgentProvider({ agentId: "pi", providerIdOverride: "my-relay" });
			expect(result).toMatchObject({
				kind: "provider",
				providerId: "my-relay",
				modelId: "relay-model",
				baseUrl: "https://relay",
			});
		});

		it("returns all-null (no config) when nothing is selected and no store config exists", () => {
			const result = resolveAgentProvider({ agentId: "pi" });
			expect(result).toEqual({
				kind: "provider",
				providerId: null,
				modelId: null,
				baseUrl: null,
				reasoningEffort: null,
				config: null,
			});
		});
	});

	describe("store-gate: an explicit full selection is not diluted by the store's reasoning", () => {
		it("does not pull store reasoning when override supplies provider+model and committed supplies baseUrl", () => {
			storeMocks.getAgentProviderConfig.mockReturnValue(
				config({
					agentId: "pi",
					provider: "openai",
					model: "gpt-x",
					baseUrl: "https://store",
					reasoning: { effort: "xhigh" },
				}),
			);
			const result = resolveAgentProvider({
				agentId: "pi",
				providerIdOverride: "openai",
				modelIdOverride: "gpt-x",
				committedProvider: { providerId: "openai", baseUrl: "https://committed" },
			});
			// All three core fields resolved before the store → the gate keeps it closed.
			expect(result).toMatchObject({ kind: "provider", baseUrl: "https://committed", reasoningEffort: null });
		});
	});

	describe("official login", () => {
		it("short-circuits to official-login when explicitly selected (CLI agent), without touching the store", () => {
			const result = resolveAgentProvider({ agentId: "claude", providerIdOverride: "official" });
			expect(result).toEqual({ kind: "official-login" });
			expect(storeMocks.getAgentProviderConfig).not.toHaveBeenCalled();
		});

		it("short-circuits to official-login when the agent's machine-home default is the sentinel", () => {
			storeMocks.getAgentProviderSet.mockReturnValue({
				agentId: "claude",
				providers: [config({ agentId: "claude", provider: "my-relay" })],
				defaultProviderId: "official",
			});
			const result = resolveAgentProvider({ agentId: "claude" });
			expect(result).toEqual({ kind: "official-login" });
			// Must never fall through to the custom default provider.
			expect(storeMocks.getAgentProviderConfig).not.toHaveBeenCalled();
		});

		it("never resolves pi to official-login even if the sentinel is passed (pi has no native login)", () => {
			const result = resolveAgentProvider({ agentId: "pi", providerIdOverride: "official" });
			// pi treats it as an ordinary (unknown) provider id, not official login.
			expect(result.kind).toBe("provider");
		});
	});

	describe("defaultProviderFallback (pi=false, CLI=true)", () => {
		const defaultConfig = config({
			agentId: "claude",
			provider: "anthropic",
			model: "claude-default",
			baseUrl: "https://default",
		});

		beforeEach(() => {
			storeMocks.getAgentProviderConfig.mockImplementation((_agentId: string, providerId?: string) => {
				if (providerId === undefined) return defaultConfig; // the agent default
				return providerId === "anthropic" ? defaultConfig : null;
			});
		});

		it("CLI: falls back to the default provider config when the explicit selection is unknown", () => {
			const result = resolveAgentProvider(
				{ agentId: "claude", providerIdOverride: "does-not-exist" },
				{ defaultProviderFallback: true },
			);
			expect(result).toMatchObject({ kind: "provider", config: defaultConfig, baseUrl: "https://default" });
		});

		it("pi: does NOT fall back — an unknown explicit selection yields no config", () => {
			const result = resolveAgentProvider({ agentId: "pi", providerIdOverride: "does-not-exist" });
			expect(result).toMatchObject({ kind: "provider", providerId: "does-not-exist", config: null, baseUrl: null });
		});
	});
});
