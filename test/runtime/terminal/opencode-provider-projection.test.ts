import { describe, expect, it } from "vitest";

import type { ResolvedAgentProvider } from "../../../src/agent-sdk/kanban/agent-provider-resolver";
import {
	buildOpenCodeProviderProjection,
	mergeOpenCodeConfig,
	projectOpenCodeProvider,
	selectOpenCodeProviderNpm,
} from "../../../src/terminal/opencode-provider-projection";

describe("opencode-provider-projection: selectOpenCodeProviderNpm", () => {
	it("maps anthropic protocol to @ai-sdk/anthropic", () => {
		expect(selectOpenCodeProviderNpm("anthropic", undefined)).toBe("@ai-sdk/anthropic");
	});

	it("maps the OpenAI Responses API to @ai-sdk/openai", () => {
		expect(selectOpenCodeProviderNpm("openai", "responses")).toBe("@ai-sdk/openai");
	});

	it("maps OpenAI chat-compatible providers to @ai-sdk/openai-compatible", () => {
		expect(selectOpenCodeProviderNpm("openai", "chat")).toBe("@ai-sdk/openai-compatible");
	});
});

describe("opencode-provider-projection: projectOpenCodeProvider", () => {
	it("projects a chat-compatible OpenAI relay using @ai-sdk/openai-compatible", () => {
		const config = projectOpenCodeProvider({
			protocol: "openai",
			providerId: "my-relay",
			modelId: "gpt-4o",
			models: ["gpt-4o", "gpt-4o-mini"],
			baseUrl: "https://relay.example.com/v1",
			apiKey: "sk-relay-123",
		});

		expect(config).toEqual({
			provider: {
				"my-relay": {
					npm: "@ai-sdk/openai-compatible",
					options: {
						baseURL: "https://relay.example.com/v1",
						apiKey: "sk-relay-123",
					},
					models: {
						"gpt-4o": {},
						"gpt-4o-mini": {},
					},
				},
			},
			model: "my-relay/gpt-4o",
			small_model: "my-relay/gpt-4o",
		});
	});

	it("projects the official OpenAI provider using @ai-sdk/openai (Responses API)", () => {
		const config = projectOpenCodeProvider({
			protocol: "openai",
			providerId: "openai",
			modelId: "gpt-5",
			baseUrl: null,
			apiKey: "sk-openai-123",
		});

		expect(config?.provider?.openai?.npm).toBe("@ai-sdk/openai");
		expect(config?.provider?.openai?.options).toEqual({ apiKey: "sk-openai-123" });
		expect(config?.model).toBe("openai/gpt-5");
		expect(config?.small_model).toBe("openai/gpt-5");
	});

	it("honors an explicit openaiApi override for a custom Responses endpoint", () => {
		const config = projectOpenCodeProvider({
			protocol: "openai",
			providerId: "my-responses-relay",
			modelId: "gpt-5",
			baseUrl: "https://relay.example.com/v1",
			apiKey: "sk-1",
			openaiApi: "responses",
		});

		expect(config?.provider?.["my-responses-relay"]?.npm).toBe("@ai-sdk/openai");
	});

	it("projects an Anthropic provider with options.apiKey (x-api-key)", () => {
		const config = projectOpenCodeProvider({
			protocol: "anthropic",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
			apiKey: "sk-ant-123",
			apiKeyField: "api_key",
		});

		expect(config?.provider?.anthropic?.npm).toBe("@ai-sdk/anthropic");
		expect(config?.provider?.anthropic?.options).toEqual({
			baseURL: "https://api.anthropic.com",
			apiKey: "sk-ant-123",
		});
		expect(config?.model).toBe("anthropic/claude-sonnet-4-6");
	});

	it("sends a Bearer Authorization header for an Anthropic relay using auth_token", () => {
		const config = projectOpenCodeProvider({
			protocol: "anthropic",
			providerId: "my-anthropic-relay",
			modelId: "claude-sonnet-4-6",
			baseUrl: "https://relay.example.com",
			apiKey: "sk-bearer-123",
			apiKeyField: "auth_token",
		});

		const entry = config?.provider?.["my-anthropic-relay"];
		expect(entry?.npm).toBe("@ai-sdk/anthropic");
		expect(entry?.options?.baseURL).toBe("https://relay.example.com");
		expect(entry?.options?.headers).toEqual({ Authorization: "Bearer sk-bearer-123" });
	});

	it("strips an existing provider prefix from the model id", () => {
		const config = projectOpenCodeProvider({
			protocol: "openai",
			providerId: "my-relay",
			modelId: "my-relay/gpt-4o",
			baseUrl: "https://relay.example.com/v1",
			apiKey: "sk-1",
		});

		expect(config?.provider?.["my-relay"]?.models).toEqual({ "gpt-4o": {} });
		expect(config?.model).toBe("my-relay/gpt-4o");
	});

	it("returns null when there is no api key, base url, or model to project", () => {
		expect(
			projectOpenCodeProvider({
				protocol: "openai",
				providerId: "empty",
				modelId: null,
				baseUrl: null,
				apiKey: null,
			}),
		).toBeNull();
	});

	it("returns null when the provider id is blank", () => {
		expect(
			projectOpenCodeProvider({
				protocol: "openai",
				providerId: "   ",
				modelId: "gpt-4o",
				baseUrl: "https://relay.example.com/v1",
				apiKey: "sk-1",
			}),
		).toBeNull();
	});
});

describe("opencode-provider-projection: buildOpenCodeProviderProjection", () => {
	it("returns null for official login", () => {
		const resolved: ResolvedAgentProvider = { kind: "official-login" };
		expect(buildOpenCodeProviderProjection("opencode", resolved)).toBeNull();
	});

	it("returns null when no machine-home provider config is resolved", () => {
		const resolved: ResolvedAgentProvider = {
			kind: "provider",
			providerId: "my-relay",
			modelId: "gpt-4o",
			baseUrl: "https://relay.example.com/v1",
			reasoningEffort: null,
			config: null,
		};
		expect(buildOpenCodeProviderProjection("opencode", resolved)).toBeNull();
	});

	it("maps a resolved OpenAI provider config into a native projection", () => {
		const resolved: ResolvedAgentProvider = {
			kind: "provider",
			providerId: "my-relay",
			modelId: "gpt-4o",
			baseUrl: "https://relay.example.com/v1",
			reasoningEffort: null,
			config: {
				agentId: "opencode",
				provider: "my-relay",
				model: "gpt-4o",
				models: ["gpt-4o"],
				apiKey: "sk-relay-123",
				protocols: [{ protocol: "openai", baseUrl: "https://relay.example.com/v1" }],
			},
		};

		const config = buildOpenCodeProviderProjection("opencode", resolved);
		expect(config?.provider?.["my-relay"]?.npm).toBe("@ai-sdk/openai-compatible");
		expect(config?.provider?.["my-relay"]?.options?.apiKey).toBe("sk-relay-123");
		expect(config?.model).toBe("my-relay/gpt-4o");
	});

	it("maps a resolved Anthropic provider config using the anthropic apiKeyField", () => {
		const resolved: ResolvedAgentProvider = {
			kind: "provider",
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
			reasoningEffort: null,
			config: {
				agentId: "opencode",
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				apiKey: "sk-ant-123",
				protocols: [{ protocol: "anthropic", baseUrl: "https://api.anthropic.com" }],
				anthropic: { apiKeyField: "api_key" },
			},
		};

		const config = buildOpenCodeProviderProjection("opencode", resolved);
		expect(config?.provider?.anthropic?.npm).toBe("@ai-sdk/anthropic");
		expect(config?.provider?.anthropic?.options?.apiKey).toBe("sk-ant-123");
		expect(config?.provider?.anthropic?.options?.headers).toBeUndefined();
	});
});

describe("opencode-provider-projection: mergeOpenCodeConfig", () => {
	it("concatenates and de-duplicates plugin arrays across fragments", () => {
		const merged = mergeOpenCodeConfig({ plugin: ["file:///a.js"] }, { plugin: ["file:///a.js", "file:///b.js"] });
		expect(merged.plugin).toEqual(["file:///a.js", "file:///b.js"]);
	});

	it("merges a hooks plugin fragment with a provider projection", () => {
		const projection = projectOpenCodeProvider({
			protocol: "openai",
			providerId: "my-relay",
			modelId: "gpt-4o",
			baseUrl: "https://relay.example.com/v1",
			apiKey: "sk-1",
		});

		const merged = mergeOpenCodeConfig({ plugin: ["file:///kanban.js"] }, projection);

		expect(merged.plugin).toEqual(["file:///kanban.js"]);
		expect(merged.provider?.["my-relay"]?.npm).toBe("@ai-sdk/openai-compatible");
		expect(merged.model).toBe("my-relay/gpt-4o");
	});

	it("preserves unrelated user base config keys", () => {
		const base = { theme: "dark", keybinds: { leader: "ctrl+a" } } as Record<string, unknown>;
		const merged = mergeOpenCodeConfig(base, { model: "my-relay/gpt-4o" });
		expect(merged.theme).toBe("dark");
		expect(merged.keybinds).toEqual({ leader: "ctrl+a" });
		expect(merged.model).toBe("my-relay/gpt-4o");
	});

	it("deep-merges a provider entry shared between base and projection (projection wins)", () => {
		const base = {
			provider: {
				openai: { npm: "@ai-sdk/openai", models: { "gpt-4o": {} }, options: { apiKey: "old" } },
			},
		};
		const projection = {
			provider: {
				openai: { npm: "@ai-sdk/openai", options: { apiKey: "new", baseURL: "https://x" } },
			},
		};
		const merged = mergeOpenCodeConfig(base, projection);
		expect(merged.provider?.openai?.options).toEqual({ apiKey: "new", baseURL: "https://x" });
		// Base models survive because the projection didn't redefine them.
		expect(merged.provider?.openai?.models).toEqual({ "gpt-4o": {} });
	});

	it("ignores null and undefined fragments", () => {
		const merged = mergeOpenCodeConfig({ model: "a/b" }, null, undefined);
		expect(merged.model).toBe("a/b");
	});
});
