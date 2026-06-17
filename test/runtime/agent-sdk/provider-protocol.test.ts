import { describe, expect, it } from "vitest";
import {
	agentSupportsOfficialLogin,
	collapseToAgentProtocol,
	extractProtocolList,
	getAgentProtocols,
	getBaseUrlForProtocol,
	getDefaultProtocolsForProvider,
	isAgentCompatibleWithProvider,
	isOfficialLoginProviderId,
	normalizeProtocols,
	normalizeProtocolsForProvider,
	OFFICIAL_LOGIN_PROVIDER_ID,
	type ProtocolConfig,
	type ProviderProtocol,
	resolveAnthropicApiKeyEnvVar,
	resolveProtocolEnvVars,
} from "../../../src/agent-sdk/kanban/provider-protocol";

// Helper to build ProtocolConfig[]
function configs(...entries: Array<[ProviderProtocol, string?]>): ProtocolConfig[] {
	return entries.map(([protocol, baseUrl]) => ({
		protocol,
		...(baseUrl ? { baseUrl } : {}),
	}));
}

describe("provider-protocol", () => {
	describe("resolveProtocolEnvVars", () => {
		it("returns ANTHROPIC env vars for claude with anthropic provider", () => {
			const result = resolveProtocolEnvVars(configs(["anthropic", "https://anthropic.example.com"]), "claude");
			expect(result).toEqual({
				baseUrlEnvVar: "ANTHROPIC_BASE_URL",
				apiKeyEnvVar: "ANTHROPIC_API_KEY",
				resolvedBaseUrl: "https://anthropic.example.com",
				matchedProtocol: "anthropic",
			});
		});

		it("returns OPENAI env vars for codex with openai provider", () => {
			const result = resolveProtocolEnvVars(configs(["openai", "https://openai.example.com"]), "codex");
			expect(result).toEqual({
				baseUrlEnvVar: "OPENAI_BASE_URL",
				apiKeyEnvVar: "OPENAI_API_KEY",
				resolvedBaseUrl: "https://openai.example.com",
				matchedProtocol: "openai",
			});
		});

		it("returns ANTHROPIC env vars for droid with anthropic provider", () => {
			const result = resolveProtocolEnvVars(configs(["anthropic"]), "droid");
			expect(result).toEqual({
				baseUrlEnvVar: "ANTHROPIC_BASE_URL",
				apiKeyEnvVar: "ANTHROPIC_API_KEY",
				resolvedBaseUrl: undefined,
				matchedProtocol: "anthropic",
			});
		});

		it("returns matching protocol env vars for multi-protocol provider", () => {
			// opencode supports both openai and anthropic
			const result = resolveProtocolEnvVars(
				configs(["openai", "https://openai.example.com"], ["anthropic", "https://anthropic.example.com"]),
				"opencode",
			);
			// Should match openai first (it's the first in agent's compatibility list)
			expect(result).toEqual({
				baseUrlEnvVar: "OPENAI_BASE_URL",
				apiKeyEnvVar: "OPENAI_API_KEY",
				resolvedBaseUrl: "https://openai.example.com",
				matchedProtocol: "openai",
			});
		});

		it("falls back to provider's first protocol when agent has no restrictions", () => {
			// gemini has no protocol restrictions
			const result = resolveProtocolEnvVars(configs(["openai", "https://openai.example.com"]), "gemini");
			expect(result).toEqual({
				baseUrlEnvVar: "OPENAI_BASE_URL",
				apiKeyEnvVar: "OPENAI_API_KEY",
				resolvedBaseUrl: "https://openai.example.com",
				matchedProtocol: "openai",
			});
		});

		it("returns null when no match found and agent has restrictions", () => {
			// claude supports anthropic, provider only has openai
			const result = resolveProtocolEnvVars(configs(["openai"]), "claude");
			expect(result).toBeNull();
		});

		it("defaults to openai when no protocols provided for unrestricted agent", () => {
			const result = resolveProtocolEnvVars([], "gemini");
			expect(result).toEqual({
				baseUrlEnvVar: "OPENAI_BASE_URL",
				apiKeyEnvVar: "OPENAI_API_KEY",
				resolvedBaseUrl: undefined,
				matchedProtocol: "openai",
			});
		});

		it("returns null when no protocols and no fallback", () => {
			const result = resolveProtocolEnvVars([], "claude");
			expect(result).toBeNull();
		});
	});

	describe("resolveAnthropicApiKeyEnvVar", () => {
		it("defaults to ANTHROPIC_AUTH_TOKEN (Bearer) when apiKeyField is unset", () => {
			expect(resolveAnthropicApiKeyEnvVar(undefined)).toBe("ANTHROPIC_AUTH_TOKEN");
		});

		it("returns ANTHROPIC_AUTH_TOKEN for auth_token", () => {
			expect(resolveAnthropicApiKeyEnvVar("auth_token")).toBe("ANTHROPIC_AUTH_TOKEN");
		});

		it("returns ANTHROPIC_API_KEY (x-api-key) for api_key", () => {
			expect(resolveAnthropicApiKeyEnvVar("api_key")).toBe("ANTHROPIC_API_KEY");
		});
	});

	describe("isAgentCompatibleWithProvider", () => {
		it("returns true when agent and provider protocols match", () => {
			expect(isAgentCompatibleWithProvider("claude", configs(["anthropic"]))).toBe(true);
			expect(isAgentCompatibleWithProvider("codex", configs(["openai"]))).toBe(true);
			expect(isAgentCompatibleWithProvider("droid", configs(["anthropic"]))).toBe(true);
		});

		it("returns false when protocols do not match", () => {
			expect(isAgentCompatibleWithProvider("claude", configs(["openai"]))).toBe(false);
			expect(isAgentCompatibleWithProvider("codex", configs(["anthropic"]))).toBe(false);
			expect(isAgentCompatibleWithProvider("kiro", configs(["openai"]))).toBe(false);
		});

		it("returns true for agents with no protocol restrictions", () => {
			expect(isAgentCompatibleWithProvider("gemini", configs(["openai"]))).toBe(true);
			expect(isAgentCompatibleWithProvider("gemini", configs(["anthropic"]))).toBe(true);
		});

		it("returns true for unknown agents (no restrictions)", () => {
			expect(isAgentCompatibleWithProvider("unknown-agent", configs(["openai"]))).toBe(true);
		});

		it("returns true for multi-protocol providers", () => {
			expect(isAgentCompatibleWithProvider("claude", configs(["openai"], ["anthropic"]))).toBe(true);
			expect(isAgentCompatibleWithProvider("codex", configs(["openai"], ["anthropic"]))).toBe(true);
		});
	});

	describe("getDefaultProtocolsForProvider", () => {
		it("returns correct defaults for known bundled providers", () => {
			expect(getDefaultProtocolsForProvider("anthropic")).toEqual([{ protocol: "anthropic" }]);
			expect(getDefaultProtocolsForProvider("openai")).toEqual([{ protocol: "openai" }]);
			expect(getDefaultProtocolsForProvider("google")).toEqual([]);
			expect(getDefaultProtocolsForProvider("amazon-bedrock")).toEqual([{ protocol: "anthropic" }]);
			expect(getDefaultProtocolsForProvider("ollama")).toEqual([{ protocol: "openai" }]);
			expect(getDefaultProtocolsForProvider("openrouter")).toEqual([
				{ protocol: "openai" },
				{ protocol: "anthropic" },
			]);
		});

		it("returns [{protocol: 'openai'}] for unknown providers", () => {
			expect(getDefaultProtocolsForProvider("my-custom-provider")).toEqual([{ protocol: "openai" }]);
		});

		it("handles case-insensitive lookup", () => {
			expect(getDefaultProtocolsForProvider("Anthropic")).toEqual([{ protocol: "anthropic" }]);
			expect(getDefaultProtocolsForProvider("OPENAI")).toEqual([{ protocol: "openai" }]);
		});
	});

	describe("normalizeProtocols", () => {
		it("returns ProtocolConfig[] as-is when already in correct format", () => {
			const input = [{ protocol: "openai" as const, baseUrl: "https://example.com" }];
			expect(normalizeProtocols(input)).toEqual(input);
		});

		it("converts legacy string[] with legacyBaseUrl", () => {
			const result = normalizeProtocols(["openai", "anthropic"], "https://legacy.example.com");
			expect(result).toEqual([
				{ protocol: "openai", baseUrl: "https://legacy.example.com" },
				{ protocol: "anthropic", baseUrl: "https://legacy.example.com" },
			]);
		});

		it("falls back to defaults for empty array", () => {
			const result = normalizeProtocols([], "https://fallback.example.com");
			// Falls back to unknown provider defaults (openai)
			expect(result).toEqual([{ protocol: "openai", baseUrl: "https://fallback.example.com" }]);
		});
	});

	describe("normalizeProtocolsForProvider", () => {
		it("uses bundled defaults when raw is empty", () => {
			const result = normalizeProtocolsForProvider([], "openrouter", "https://router.example.com");
			expect(result).toEqual([
				{ protocol: "openai", baseUrl: "https://router.example.com" },
				{ protocol: "anthropic", baseUrl: "https://router.example.com" },
			]);
		});

		it("converts legacy string[] for a known provider", () => {
			const result = normalizeProtocolsForProvider(["anthropic"], "anthropic", "https://anthropic.example.com");
			expect(result).toEqual([{ protocol: "anthropic", baseUrl: "https://anthropic.example.com" }]);
		});
	});

	describe("getBaseUrlForProtocol", () => {
		it("returns the baseUrl for a matching protocol", () => {
			const configs: ProtocolConfig[] = [
				{ protocol: "openai", baseUrl: "https://openai.example.com" },
				{ protocol: "anthropic", baseUrl: "https://anthropic.example.com" },
			];
			expect(getBaseUrlForProtocol(configs, "openai")).toBe("https://openai.example.com");
			expect(getBaseUrlForProtocol(configs, "anthropic")).toBe("https://anthropic.example.com");
		});

		it("returns undefined for a missing protocol", () => {
			const configs: ProtocolConfig[] = [{ protocol: "openai", baseUrl: "https://openai.example.com" }];
			expect(getBaseUrlForProtocol(configs, "anthropic")).toBeUndefined();
		});

		it("returns undefined when baseUrl is empty", () => {
			const configs: ProtocolConfig[] = [{ protocol: "openai", baseUrl: "  " }];
			expect(getBaseUrlForProtocol(configs, "openai")).toBeUndefined();
		});
	});

	describe("getAgentProtocols", () => {
		it("returns the agent's compatible protocols", () => {
			expect(getAgentProtocols("claude")).toEqual(["anthropic"]);
			expect(getAgentProtocols("codex")).toEqual(["openai"]);
			expect(getAgentProtocols("opencode")).toEqual(["openai", "anthropic"]);
		});

		it("returns [] for unrestricted and unknown agents (case-insensitive)", () => {
			expect(getAgentProtocols("gemini")).toEqual([]);
			expect(getAgentProtocols("UNKNOWN")).toEqual([]);
			expect(getAgentProtocols("Claude")).toEqual(["anthropic"]);
		});
	});

	describe("collapseToAgentProtocol", () => {
		it("keeps the agent's single protocol with its base URL", () => {
			expect(collapseToAgentProtocol("claude", configs(["anthropic", "https://a.example.com"]))).toEqual({
				protocol: "anthropic",
				baseUrl: "https://a.example.com",
			});
		});

		it("drops a second, never-used protocol for a single-protocol agent", () => {
			// codex only speaks openai — the anthropic entry is dead config.
			expect(
				collapseToAgentProtocol(
					"codex",
					configs(["openai", "https://o.example.com"], ["anthropic", "https://a.example.com"]),
				),
			).toEqual({ protocol: "openai", baseUrl: "https://o.example.com" });
		});

		it("picks the agent's primary protocol when the provider speaks none of them", () => {
			// claude provider only configured openai → coerce to anthropic (claude's protocol).
			expect(collapseToAgentProtocol("claude", configs(["openai", "https://o.example.com"]))).toEqual({
				protocol: "anthropic",
				baseUrl: "https://o.example.com",
			});
		});

		it("lets a multi-protocol agent keep the single protocol it was given", () => {
			// opencode supports both; a provider configured anthropic-only stays anthropic.
			expect(collapseToAgentProtocol("opencode", configs(["anthropic", "https://a.example.com"]))).toEqual({
				protocol: "anthropic",
				baseUrl: "https://a.example.com",
			});
		});

		it("folds a legacy scalar baseUrl into the chosen protocol when no protocols are set", () => {
			expect(collapseToAgentProtocol("pi", undefined, "https://legacy.example.com")).toEqual({
				protocol: "openai",
				baseUrl: "https://legacy.example.com",
			});
		});

		it("prefers the per-protocol baseUrl over the legacy scalar", () => {
			expect(
				collapseToAgentProtocol(
					"claude",
					configs(["anthropic", "https://proto.example.com"]),
					"https://legacy.example.com",
				),
			).toEqual({ protocol: "anthropic", baseUrl: "https://proto.example.com" });
		});

		it("returns a protocol with no baseUrl when none is available", () => {
			expect(collapseToAgentProtocol("codex", [])).toEqual({ protocol: "openai" });
		});

		it("defaults an unrestricted agent to the first present protocol, else openai", () => {
			expect(collapseToAgentProtocol("gemini", configs(["anthropic", "https://a.example.com"]))).toEqual({
				protocol: "anthropic",
				baseUrl: "https://a.example.com",
			});
			expect(collapseToAgentProtocol("gemini", [])).toEqual({ protocol: "openai" });
		});
	});

	describe("extractProtocolList", () => {
		it("extracts protocol names from ProtocolConfig[]", () => {
			const configs: ProtocolConfig[] = [
				{ protocol: "openai", baseUrl: "https://openai.example.com" },
				{ protocol: "anthropic" },
			];
			expect(extractProtocolList(configs)).toEqual(["openai", "anthropic"]);
		});
	});

	describe("official login", () => {
		it("recognizes the sentinel id regardless of casing/whitespace", () => {
			expect(isOfficialLoginProviderId(OFFICIAL_LOGIN_PROVIDER_ID)).toBe(true);
			expect(isOfficialLoginProviderId("  Official  ")).toBe(true);
			expect(isOfficialLoginProviderId("OFFICIAL")).toBe(true);
		});

		it("does not match other ids or empty values", () => {
			expect(isOfficialLoginProviderId("anthropic")).toBe(false);
			expect(isOfficialLoginProviderId("")).toBe(false);
			expect(isOfficialLoginProviderId(null)).toBe(false);
			expect(isOfficialLoginProviderId(undefined)).toBe(false);
		});

		it("supports official login for CLI agents but not pi", () => {
			expect(agentSupportsOfficialLogin("claude")).toBe(true);
			expect(agentSupportsOfficialLogin("codex")).toBe(true);
			expect(agentSupportsOfficialLogin("gemini")).toBe(true);
			expect(agentSupportsOfficialLogin("pi")).toBe(false);
			expect(agentSupportsOfficialLogin("  PI  ")).toBe(false);
		});
	});
});
