import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted so paths are available before module evaluation (vi.mock hoists).
// We keep a mock home dir purely to assert that NO code writes ~/.claude/settings.json
// anymore — provider config is injected as per-spawn env, never a global settings file.
const { mockHome, mockClaudeDir, mockSettingsPath } = vi.hoisted(() => {
	const tmpBase = process.env.TMPDIR ?? process.env.TMP ?? "/tmp";
	const home = `${tmpBase}/kanban-env-injector-test-${Date.now()}`;
	return {
		mockHome: home,
		mockClaudeDir: `${home}/.claude`,
		mockSettingsPath: `${home}/.claude/settings.json`,
	};
});

// Mock homedir to use temp dir
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return {
		...actual,
		homedir: () => mockHome,
	};
});

// Mock the agent-provider-config module.
const agentProviderMocks = vi.hoisted(() => ({
	getAgentProviderConfig: vi.fn(),
	getAgentProviderSet: vi.fn(),
}));

vi.mock("../../../src/agent-sdk/kanban/agent-provider-config", () => ({
	getAgentProviderConfig: agentProviderMocks.getAgentProviderConfig,
	getAgentProviderSet: agentProviderMocks.getAgentProviderSet,
	normalizeProviderId: (id: string | undefined | null) => (id ?? "").trim().toLowerCase(),
}));

import { buildAgentProviderEnv } from "../../../src/unified-proxy/env-injector";

describe("env-injector: buildAgentProviderEnv", () => {
	beforeEach(() => {
		agentProviderMocks.getAgentProviderConfig.mockReset();
		agentProviderMocks.getAgentProviderSet.mockReset();
		agentProviderMocks.getAgentProviderSet.mockReturnValue(null);
		if (existsSync(mockClaudeDir)) {
			rmSync(mockClaudeDir, { recursive: true });
		}
	});

	afterEach(() => {
		if (existsSync(mockClaudeDir)) {
			rmSync(mockClaudeDir, { recursive: true });
		}
	});

	it("returns empty env when claude has no config (official provider)", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue(null);

		const result = await buildAgentProviderEnv("claude");
		expect(result.usesCustomProvider).toBe(false);
		expect(result.env).toEqual({});
		// No global settings file is ever written.
		expect(existsSync(mockSettingsPath)).toBe(false);
	});

	it("injects ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (default) for a custom claude provider", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "claude",
			provider: "custom-aliyun",
			baseUrl: "https://custom.aliyun.com/v1",
			apiKey: "sk-custom-123",
		});

		const result = await buildAgentProviderEnv("claude");
		expect(result.usesCustomProvider).toBe(true);
		// Default key field is auth_token (Bearer) — most relays expect this.
		expect(result.env).toEqual({
			ANTHROPIC_BASE_URL: "https://custom.aliyun.com/v1",
			ANTHROPIC_AUTH_TOKEN: "sk-custom-123",
		});
		// Never writes a global settings file.
		expect(existsSync(mockSettingsPath)).toBe(false);
	});

	it("injects ANTHROPIC_API_KEY (x-api-key) for claude when apiKeyField is api_key", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "claude",
			provider: "anthropic",
			anthropic: { apiKeyField: "api_key" },
			protocols: [{ protocol: "anthropic", baseUrl: "https://api.anthropic.com" }],
			apiKey: "sk-ant-official",
		});

		const result = await buildAgentProviderEnv("claude");
		expect(result.usesCustomProvider).toBe(true);
		expect(result.env).toEqual({
			ANTHROPIC_BASE_URL: "https://api.anthropic.com",
			ANTHROPIC_API_KEY: "sk-ant-official",
		});
	});

	it("injects optional ANTHROPIC_MODEL from the claude provider config", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "claude",
			provider: "custom",
			baseUrl: "https://relay.example.com",
			apiKey: "sk-relay",
			model: "claude-opus-4-8",
		});

		const result = await buildAgentProviderEnv("claude");
		expect(result.env).toEqual({
			ANTHROPIC_BASE_URL: "https://relay.example.com",
			ANTHROPIC_AUTH_TOKEN: "sk-relay",
			ANTHROPIC_MODEL: "claude-opus-4-8",
		});
	});

	it("injects ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL when present in config", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "claude",
			provider: "custom",
			baseUrl: "https://relay.example.com",
			apiKey: "sk-relay",
			anthropic: {
				defaultModels: {
					haiku: "relay-haiku",
					sonnet: "relay-sonnet",
					opus: "relay-opus",
				},
			},
		});

		const result = await buildAgentProviderEnv("claude");
		expect(result.env).toEqual({
			ANTHROPIC_BASE_URL: "https://relay.example.com",
			ANTHROPIC_AUTH_TOKEN: "sk-relay",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "relay-haiku",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "relay-sonnet",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "relay-opus",
		});
	});

	it("injects only ANTHROPIC_BASE_URL when claude provider has no apiKey", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "claude",
			provider: "custom-no-key",
			baseUrl: "https://no-key.example.com",
		});

		const result = await buildAgentProviderEnv("claude");
		expect(result.usesCustomProvider).toBe(true);
		expect(result.env).toEqual({
			ANTHROPIC_BASE_URL: "https://no-key.example.com",
		});
		expect(existsSync(mockSettingsPath)).toBe(false);
	});

	it("injects OPENAI_BASE_URL and OPENAI_API_KEY for Codex with custom provider", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "codex",
			provider: "custom-gpt",
			baseUrl: "https://custom.gpt.com/v1",
			apiKey: "sk-gpt-456",
			protocols: [{ protocol: "openai", baseUrl: "https://custom.gpt.com/v1" }],
		});

		const result = await buildAgentProviderEnv("codex");
		expect(result.usesCustomProvider).toBe(true);
		expect(result.env.OPENAI_BASE_URL).toBe("https://custom.gpt.com/v1");
		expect(result.env.OPENAI_API_KEY).toBe("sk-gpt-456");
	});

	it("injects no env for droid — it projects providers natively via BYOK customModels", async () => {
		// Droid does NOT use generic env-var injection; its session adapter projects
		// the provider into a `customModels` entry in settings.json. The env path is
		// a deliberate no-op so the two mechanisms never both fire. See `droid-byok.ts`.
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "droid",
			provider: "custom-droid",
			baseUrl: "https://droid.example.com",
			apiKey: "dk-789",
			protocols: [{ protocol: "anthropic", baseUrl: "https://droid.example.com" }],
		});

		const result = await buildAgentProviderEnv("droid");
		expect(result.usesCustomProvider).toBe(false);
		expect(result.env).toEqual({});
		// The store is never even consulted for a native-projection agent.
		expect(agentProviderMocks.getAgentProviderConfig).not.toHaveBeenCalled();
	});

	it("injects GEMINI_API_KEY + GEMINI_MODEL for gemini (vendor), never OPENAI_*/baseUrl", async () => {
		// Even if a stale baseUrl/protocols leaked onto the config, gemini is a
		// vendor agent: it speaks only its native API, so we must NOT inject the
		// generic OPENAI_* override (which the Gemini CLI ignores → silent failure).
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "gemini",
			provider: "google",
			apiKey: "gk-000",
			model: "gemini-2.5-pro",
			baseUrl: "https://leftover.example.com",
			protocols: [{ protocol: "openai", baseUrl: "https://leftover.example.com" }],
		});

		const result = await buildAgentProviderEnv("gemini");
		expect(result.usesCustomProvider).toBe(true);
		expect(result.env).toEqual({
			GEMINI_API_KEY: "gk-000",
			GEMINI_MODEL: "gemini-2.5-pro",
		});
		expect(result.env.OPENAI_BASE_URL).toBeUndefined();
		expect(result.env.OPENAI_API_KEY).toBeUndefined();
		expect(result.resolvedModelId).toBe("gemini-2.5-pro");
	});

	it("injects Vertex env for gemini when a GCP project is configured", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "gemini",
			provider: "vertex",
			apiKey: "gk-vertex",
			model: "gemini-2.5-flash",
			gcp: { projectId: "my-proj", region: "us-central1" },
		});

		const result = await buildAgentProviderEnv("gemini");
		expect(result.env).toEqual({
			GOOGLE_GENAI_USE_VERTEXAI: "true",
			GOOGLE_CLOUD_PROJECT: "my-proj",
			GOOGLE_CLOUD_LOCATION: "us-central1",
			GOOGLE_API_KEY: "gk-vertex",
			GEMINI_MODEL: "gemini-2.5-flash",
		});
		// Vertex mode must not also set the AI-Studio key var.
		expect(result.env.GEMINI_API_KEY).toBeUndefined();
	});

	it("injects NO env for kiro (vendor v1: official login) but surfaces the resolved model", async () => {
		// Kiro applies its model via its native agent config, not env, and uses its
		// official login. The custom API-key env contract is deferred, so no key env.
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "kiro",
			provider: "kiro",
			apiKey: "should-be-ignored",
			model: "kiro-model-1",
		});

		const result = await buildAgentProviderEnv("kiro");
		expect(result.usesCustomProvider).toBe(false);
		expect(result.env).toEqual({});
		expect(result.resolvedModelId).toBe("kiro-model-1");
	});

	it("injects CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY when enabled on the anthropic provider", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "claude",
			provider: "gateway",
			baseUrl: "https://gateway.example.com",
			apiKey: "sk-gw",
			anthropic: { enableGatewayModelDiscovery: true },
		});

		const result = await buildAgentProviderEnv("claude");
		expect(result.env).toEqual({
			ANTHROPIC_BASE_URL: "https://gateway.example.com",
			ANTHROPIC_AUTH_TOKEN: "sk-gw",
			CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
		});
	});

	it("does NOT inject the gateway flag when the option is absent or false", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "claude",
			provider: "gateway",
			baseUrl: "https://gateway.example.com",
			apiKey: "sk-gw",
			anthropic: { enableGatewayModelDiscovery: false },
		});

		const result = await buildAgentProviderEnv("claude");
		expect(result.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined();
	});

	it("throws when provider protocols are incompatible with the agent", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "codex",
			provider: "anthropic-only-provider",
			baseUrl: "https://anthropic-only.example.com",
			apiKey: "sk-anthropic",
			protocols: [{ protocol: "anthropic", baseUrl: "https://anthropic-only.example.com" }],
		});

		// codex supports only openai; the provider speaks only anthropic. Rather
		// than silently launching with no override, this surfaces an error.
		await expect(buildAgentProviderEnv("codex")).rejects.toThrow(/cannot use/i);
	});

	it("returns empty env when provider config is null (not found)", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue(null);

		const result = await buildAgentProviderEnv("claude");
		expect(result.usesCustomProvider).toBe(false);
		expect(result.env).toEqual({});
	});

	describe("per-session provider selection", () => {
		// Two providers registered for claude. The mock resolves by providerId,
		// mirroring getAgentProviderConfig(agentId, providerId) with default fallback.
		const PROVIDERS: Record<string, { agentId: string; provider: string; baseUrl: string; apiKey: string }> = {
			anthropic: {
				agentId: "claude",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				apiKey: "sk-default",
			},
			"my-relay": {
				agentId: "claude",
				provider: "my-relay",
				baseUrl: "https://relay.local/v1",
				apiKey: "sk-relay",
			},
		};
		const DEFAULT_ID = "anthropic";

		beforeEach(() => {
			agentProviderMocks.getAgentProviderConfig.mockImplementation((_agentId: string, providerId?: string) => {
				if (providerId === undefined) {
					return PROVIDERS[DEFAULT_ID];
				}
				return PROVIDERS[providerId] ?? null;
			});
		});

		it("injects the selected provider's env when a providerId is given", async () => {
			const a = await buildAgentProviderEnv("claude", "anthropic");
			const b = await buildAgentProviderEnv("claude", "my-relay");

			// Two sessions of the same agent get distinct, independent env.
			expect(a.env).toEqual({
				ANTHROPIC_BASE_URL: "https://api.anthropic.com",
				ANTHROPIC_AUTH_TOKEN: "sk-default",
			});
			expect(b.env).toEqual({
				ANTHROPIC_BASE_URL: "https://relay.local/v1",
				ANTHROPIC_AUTH_TOKEN: "sk-relay",
			});
		});

		it("falls back to the default provider when no providerId is given", async () => {
			const result = await buildAgentProviderEnv("claude");
			expect(result.env).toEqual({
				ANTHROPIC_BASE_URL: "https://api.anthropic.com",
				ANTHROPIC_AUTH_TOKEN: "sk-default",
			});
		});

		it("falls back to the default provider when the selected providerId is unknown", async () => {
			const result = await buildAgentProviderEnv("claude", "does-not-exist");
			expect(result.env).toEqual({
				ANTHROPIC_BASE_URL: "https://api.anthropic.com",
				ANTHROPIC_AUTH_TOKEN: "sk-default",
			});
		});

		it("injects NO env when official login is selected, even with a custom default provider", async () => {
			// The agent has a custom default provider, but the session explicitly
			// selected official login — we must NOT fall through to the custom default.
			const result = await buildAgentProviderEnv("claude", "official");
			expect(result.usesCustomProvider).toBe(false);
			expect(result.env).toEqual({});
			// The fallback chain must not even be consulted.
			expect(agentProviderMocks.getAgentProviderConfig).not.toHaveBeenCalled();
		});
	});

	describe("workspace committed provider", () => {
		it("selects the committed provider for a supporting agent and applies its model", async () => {
			// The machine-home store holds the secret + protocol for the committed
			// provider id; the committed record (secret-free) selects it and supplies
			// the model.
			agentProviderMocks.getAgentProviderConfig.mockImplementation((_agentId: string, providerId?: string) =>
				providerId === "my-relay"
					? {
							agentId: "claude",
							provider: "my-relay",
							apiKey: "sk-relay",
							protocols: [{ protocol: "anthropic", baseUrl: "https://relay.local/v1" }],
						}
					: null,
			);

			const result = await buildAgentProviderEnv("claude", undefined, {
				providerId: "my-relay",
				modelId: "committed-opus",
			});

			expect(result.usesCustomProvider).toBe(true);
			expect(result.env).toEqual({
				ANTHROPIC_BASE_URL: "https://relay.local/v1",
				ANTHROPIC_AUTH_TOKEN: "sk-relay",
				ANTHROPIC_MODEL: "committed-opus",
			});
		});

		it("lets a card-level provider override win over the committed provider", async () => {
			agentProviderMocks.getAgentProviderConfig.mockImplementation((_agentId: string, providerId?: string) => {
				if (providerId === "card-relay") {
					return {
						agentId: "claude",
						provider: "card-relay",
						apiKey: "sk-card",
						protocols: [{ protocol: "anthropic", baseUrl: "https://card.local" }],
					};
				}
				return null;
			});

			const result = await buildAgentProviderEnv("claude", "card-relay", { providerId: "committed-relay" });
			expect(result.env).toEqual({
				ANTHROPIC_BASE_URL: "https://card.local",
				ANTHROPIC_AUTH_TOKEN: "sk-card",
			});
		});
	});

	describe("official login", () => {
		it("injects NO env when the agent's default provider is the official sentinel", async () => {
			// providerId omitted → resolve from the set's default, which is "official".
			agentProviderMocks.getAgentProviderSet.mockReturnValue({
				agentId: "claude",
				providers: [
					{ agentId: "claude", provider: "my-relay", baseUrl: "https://relay.local/v1", apiKey: "sk-relay" },
				],
				defaultProviderId: "official",
			});
			// Even if something asked the config store, it would return the relay; assert we don't.
			agentProviderMocks.getAgentProviderConfig.mockReturnValue({
				agentId: "claude",
				provider: "my-relay",
				baseUrl: "https://relay.local/v1",
				apiKey: "sk-relay",
			});

			const result = await buildAgentProviderEnv("claude");
			expect(result.usesCustomProvider).toBe(false);
			expect(result.env).toEqual({});
			expect(agentProviderMocks.getAgentProviderConfig).not.toHaveBeenCalled();
		});

		it("treats the sentinel case-insensitively / trimmed", async () => {
			const result = await buildAgentProviderEnv("claude", "  Official  ");
			expect(result.env).toEqual({});
			expect(result.usesCustomProvider).toBe(false);
		});
	});
});
