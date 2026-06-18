import { describe, expect, it } from "vitest";

import type { AgentProviderConfig } from "../../../src/agent-sdk/kanban/agent-provider-config";
import {
	buildDroidByokProjection,
	DROID_BYOK_API_KEY_ENV_VAR,
	DroidByokConfigError,
	type DroidCustomModel,
	mergeDroidCustomModels,
	selectDroidProviderType,
} from "../../../src/agent-sdk/kanban/droid-byok";
import { IncompatibleAgentProviderError } from "../../../src/agent-sdk/kanban/provider-protocol";

function config(overrides: Partial<AgentProviderConfig>): AgentProviderConfig {
	return {
		agentId: "droid",
		provider: "my-relay",
		apiKey: "sk-secret-123",
		model: "claude-sonnet-4-5",
		protocols: [{ protocol: "anthropic", baseUrl: "https://relay.example.com" }],
		...overrides,
	};
}

describe("selectDroidProviderType", () => {
	it("maps the anthropic protocol to the anthropic provider type", () => {
		expect(selectDroidProviderType("anthropic", "anthropic")).toBe("anthropic");
		expect(selectDroidProviderType("anthropic", "some-relay")).toBe("anthropic");
	});

	it("maps the native OpenAI provider to the openai (Responses API) type", () => {
		expect(selectDroidProviderType("openai", "openai")).toBe("openai");
		expect(selectDroidProviderType("openai", "azure-openai")).toBe("openai");
		expect(selectDroidProviderType("openai", "OpenAI")).toBe("openai");
	});

	it("maps other OpenAI-protocol providers to generic-chat-completion-api", () => {
		expect(selectDroidProviderType("openai", "openrouter")).toBe("generic-chat-completion-api");
		expect(selectDroidProviderType("openai", "ollama")).toBe("generic-chat-completion-api");
		expect(selectDroidProviderType("openai", "groq")).toBe("generic-chat-completion-api");
		expect(selectDroidProviderType("openai", null)).toBe("generic-chat-completion-api");
		expect(selectDroidProviderType("openai", undefined)).toBe("generic-chat-completion-api");
	});
});

describe("buildDroidByokProjection", () => {
	it("projects an Anthropic provider with env-interpolated apiKey by default", () => {
		const projection = buildDroidByokProjection({ config: config({}), model: "claude-sonnet-4-5" });

		expect(projection.model).toBe("claude-sonnet-4-5");
		expect(projection.customModel).toEqual({
			model: "claude-sonnet-4-5",
			displayName: "my-relay",
			baseUrl: "https://relay.example.com",
			apiKey: `\${${DROID_BYOK_API_KEY_ENV_VAR}}`,
			provider: "anthropic",
		});
		// The real secret never lands in the customModel — it is injected as env.
		expect(projection.env).toEqual({ [DROID_BYOK_API_KEY_ENV_VAR]: "sk-secret-123" });
	});

	it("projects an OpenAI-protocol relay as generic-chat-completion-api", () => {
		const projection = buildDroidByokProjection({
			config: config({
				provider: "openrouter",
				protocols: [{ protocol: "openai", baseUrl: "https://openrouter.ai/api/v1" }],
				model: "x-ai/grok-2",
			}),
			model: "x-ai/grok-2",
		});

		expect(projection.customModel.provider).toBe("generic-chat-completion-api");
		expect(projection.customModel.baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(projection.customModel.model).toBe("x-ai/grok-2");
	});

	it("projects the native OpenAI provider as the openai Responses API type", () => {
		const projection = buildDroidByokProjection({
			config: config({
				provider: "openai",
				protocols: [{ protocol: "openai", baseUrl: "https://api.openai.com/v1" }],
				model: "gpt-5",
			}),
			model: "gpt-5",
		});

		expect(projection.customModel.provider).toBe("openai");
	});

	it("supports a literal apiKey strategy (session-only settings file)", () => {
		const projection = buildDroidByokProjection({
			config: config({}),
			model: "claude-sonnet-4-5",
			apiKeyStrategy: { kind: "literal" },
		});

		expect(projection.customModel.apiKey).toBe("sk-secret-123");
		// Literal mode injects no env — the key lives only in the (machine-home, gitignored) file.
		expect(projection.env).toEqual({});
	});

	it("honors a custom env var name for interpolation", () => {
		const projection = buildDroidByokProjection({
			config: config({}),
			model: "claude-sonnet-4-5",
			apiKeyStrategy: { kind: "env-interpolation", envVar: "MY_KEY" },
		});

		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} is Droid's apiKey env-interpolation syntax, not a template.
		expect(projection.customModel.apiKey).toBe("${MY_KEY}");
		expect(projection.env).toEqual({ MY_KEY: "sk-secret-123" });
	});

	it("falls back to the legacy scalar baseUrl when protocols carry none", () => {
		const projection = buildDroidByokProjection({
			config: config({ protocols: [{ protocol: "anthropic" }], baseUrl: "https://legacy.example.com" }),
			model: "claude-sonnet-4-5",
		});

		expect(projection.customModel.baseUrl).toBe("https://legacy.example.com");
	});

	it("falls back to the config model when no resolved model is supplied", () => {
		const projection = buildDroidByokProjection({ config: config({ model: "fallback-model" }), model: null });
		expect(projection.model).toBe("fallback-model");
		expect(projection.customModel.model).toBe("fallback-model");
	});

	it("derives the displayName from the model when no provider name is set", () => {
		const projection = buildDroidByokProjection({
			config: config({ provider: undefined }),
			model: "claude-sonnet-4-5",
		});
		expect(projection.customModel.displayName).toBe("claude-sonnet-4-5");
	});

	it("throws a clear error when the provider speaks no Droid-compatible protocol", () => {
		expect(() => buildDroidByokProjection({ config: config({ protocols: [] }), model: "m" })).toThrow(
			IncompatibleAgentProviderError,
		);
	});

	it("throws a clear config error when the baseUrl is missing", () => {
		expect(() =>
			buildDroidByokProjection({
				config: config({ protocols: [{ protocol: "anthropic" }], baseUrl: undefined }),
				model: "m",
			}),
		).toThrow(DroidByokConfigError);
	});

	it("throws a clear config error when no model can be resolved", () => {
		expect(() => buildDroidByokProjection({ config: config({ model: undefined }), model: null })).toThrow(
			DroidByokConfigError,
		);
	});

	it("throws a clear config error when the apiKey is missing", () => {
		expect(() => buildDroidByokProjection({ config: config({ apiKey: undefined }), model: "m" })).toThrow(
			DroidByokConfigError,
		);
	});
});

describe("mergeDroidCustomModels", () => {
	const ours: DroidCustomModel = {
		model: "claude-sonnet-4-5",
		baseUrl: "https://relay.example.com",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} is Droid's apiKey env-interpolation syntax, not a template.
		apiKey: "${KEY}",
		provider: "anthropic",
	};

	it("preserves unrelated existing settings fields", () => {
		const merged = mergeDroidCustomModels({ autonomyMode: "auto-high", hooks: { Stop: [] } }, [ours]);
		expect(merged.autonomyMode).toBe("auto-high");
		expect(merged.hooks).toEqual({ Stop: [] });
		expect(merged.customModels).toEqual([ours]);
	});

	it("preserves a user's existing custom models with different ids", () => {
		const userModel = {
			model: "user/local-model",
			baseUrl: "http://localhost:11434/v1",
			apiKey: "x",
			provider: "generic-chat-completion-api",
		};
		const merged = mergeDroidCustomModels({ customModels: [userModel] }, [ours]);
		expect(merged.customModels).toEqual([userModel, ours]);
	});

	it("replaces an existing entry that shares our model id (ours wins)", () => {
		const stale = { model: "claude-sonnet-4-5", baseUrl: "old", apiKey: "old", provider: "anthropic" };
		const merged = mergeDroidCustomModels({ customModels: [stale] }, [ours]);
		expect(merged.customModels).toEqual([ours]);
	});

	it("tolerates a non-array customModels field", () => {
		const merged = mergeDroidCustomModels({ customModels: "garbage" as unknown as never }, [ours]);
		expect(merged.customModels).toEqual([ours]);
	});
});
