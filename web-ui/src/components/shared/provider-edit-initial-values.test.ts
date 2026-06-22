import { describe, expect, it } from "vitest";
import type { RuntimeAgentProviderConfig } from "@/runtime/types";
import { buildProviderEditInitialValues } from "./provider-edit-initial-values";

describe("buildProviderEditInitialValues", () => {
	it("maps a per-agent provider config to the edit dialog's initial values", () => {
		const config: RuntimeAgentProviderConfig = {
			agentId: "codex",
			provider: "my-relay",
			model: "gpt-4o",
			models: ["gpt-4o", "gpt-4o-mini"],
			modelsSourceUrl: "https://relay.example.com/v1/models",
			baseUrl: "https://relay.example.com/v1",
			protocols: [{ protocol: "openai", baseUrl: "https://relay.example.com/v1" }],
			apiKeyPreview: "sk-r…wxyz",
			headers: { "x-team": "kanban" },
			timeout: 30000,
		};

		const initial = buildProviderEditInitialValues(config);

		expect(initial.providerId).toBe("my-relay");
		expect(initial.name).toBe("my-relay");
		expect(initial.baseUrl).toBe("https://relay.example.com/v1");
		expect(initial.defaultModelId).toBe("gpt-4o");
		expect(initial.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
		expect(initial.modelsSourceUrl).toBe("https://relay.example.com/v1/models");
		expect(initial.protocols).toEqual(["openai"]);
		expect(initial.protocolConfigs).toEqual([{ protocol: "openai", baseUrl: "https://relay.example.com/v1" }]);
		expect(initial.apiKeyPreview).toBe("sk-r…wxyz");
		expect(initial.headers).toEqual({ "x-team": "kanban" });
		expect(initial.timeoutMs).toBe(30000);
	});

	it("uses the provider's OWN preview (the per-agent config is the source of truth)", () => {
		// Regression: the edit dialog previously sourced initial values from a global,
		// name-keyed catalog that collapsed same-named providers across agents, so it
		// could show another agent's (or an empty) key. Building straight from the
		// per-agent config makes that impossible.
		const claudeConfig: RuntimeAgentProviderConfig = {
			agentId: "claude",
			provider: "anthropic",
			apiKeyPreview: "sk-c…AAAA",
			protocols: [{ protocol: "anthropic", baseUrl: "https://claude.example.com" }],
		};
		const codexConfig: RuntimeAgentProviderConfig = {
			agentId: "codex",
			provider: "anthropic",
			apiKeyPreview: "sk-x…BBBB",
			protocols: [{ protocol: "openai", baseUrl: "https://codex.example.com" }],
		};

		expect(buildProviderEditInitialValues(claudeConfig).apiKeyPreview).toBe("sk-c…AAAA");
		expect(buildProviderEditInitialValues(claudeConfig).baseUrl).toBe("https://claude.example.com");
		expect(buildProviderEditInitialValues(codexConfig).apiKeyPreview).toBe("sk-x…BBBB");
		expect(buildProviderEditInitialValues(codexConfig).baseUrl).toBe("https://codex.example.com");
	});

	it("falls back to empty/derived values when optional fields are absent", () => {
		const config: RuntimeAgentProviderConfig = { agentId: "pi", provider: "local" };
		const initial = buildProviderEditInitialValues(config);
		expect(initial.providerId).toBe("local");
		expect(initial.name).toBe("local");
		expect(initial.baseUrl).toBe("");
		expect(initial.models).toEqual([]);
		expect(initial.apiKeyPreview ?? null).toBeNull();
	});
});
