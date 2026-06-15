import { describe, expect, it } from "vitest";
import {
	resolveProtocolEnvVars,
	isAgentCompatibleWithProvider,
	getDefaultProtocolsForProvider,
	normalizeProtocols,
	normalizeProtocolsForProvider,
	getBaseUrlForProtocol,
	extractProtocolList,
	type ProviderProtocol,
	type ProtocolConfig,
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
			});
		});

		it("returns OPENAI env vars for codex with openai provider", () => {
			const result = resolveProtocolEnvVars(configs(["openai", "https://openai.example.com"]), "codex");
			expect(result).toEqual({
				baseUrlEnvVar: "OPENAI_BASE_URL",
				apiKeyEnvVar: "OPENAI_API_KEY",
				resolvedBaseUrl: "https://openai.example.com",
			});
		});

		it("returns ANTHROPIC env vars for droid with anthropic provider", () => {
			const result = resolveProtocolEnvVars(configs(["anthropic"]), "droid");
			expect(result).toEqual({
				baseUrlEnvVar: "ANTHROPIC_BASE_URL",
				apiKeyEnvVar: "ANTHROPIC_API_KEY",
				resolvedBaseUrl: undefined,
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
			});
		});

		it("falls back to provider's first protocol when agent has no restrictions", () => {
			// gemini has no protocol restrictions
			const result = resolveProtocolEnvVars(configs(["openai", "https://openai.example.com"]), "gemini");
			expect(result).toEqual({
				baseUrlEnvVar: "OPENAI_BASE_URL",
				apiKeyEnvVar: "OPENAI_API_KEY",
				resolvedBaseUrl: "https://openai.example.com",
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
			});
		});

		it("returns null when no protocols and no fallback", () => {
			const result = resolveProtocolEnvVars([], "claude");
			expect(result).toBeNull();
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
			expect(result).toEqual([
				{ protocol: "anthropic", baseUrl: "https://anthropic.example.com" },
			]);
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

	describe("extractProtocolList", () => {
		it("extracts protocol names from ProtocolConfig[]", () => {
			const configs: ProtocolConfig[] = [
				{ protocol: "openai", baseUrl: "https://openai.example.com" },
				{ protocol: "anthropic" },
			];
			expect(extractProtocolList(configs)).toEqual(["openai", "anthropic"]);
		});
	});
});
