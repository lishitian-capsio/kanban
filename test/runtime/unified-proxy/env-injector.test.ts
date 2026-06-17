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
}));

vi.mock("../../../src/agent-sdk/kanban/agent-provider-config", () => ({
	getAgentProviderConfig: agentProviderMocks.getAgentProviderConfig,
}));

import { buildAgentProviderEnv } from "../../../src/unified-proxy/env-injector";

describe("env-injector: buildAgentProviderEnv", () => {
	beforeEach(() => {
		agentProviderMocks.getAgentProviderConfig.mockReset();
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

	it("injects ANTHROPIC env vars for droid with custom provider (auth_token default)", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "droid",
			provider: "custom-droid",
			baseUrl: "https://droid.example.com",
			apiKey: "dk-789",
			protocols: [{ protocol: "anthropic", baseUrl: "https://droid.example.com" }],
		});

		const result = await buildAgentProviderEnv("droid");
		expect(result.usesCustomProvider).toBe(true);
		expect(result.env.ANTHROPIC_BASE_URL).toBe("https://droid.example.com");
		expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe("dk-789");
		expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("injects OPENAI env vars for gemini when provider supports openai protocol", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "gemini",
			provider: "custom-gemini",
			baseUrl: "https://custom.gemini.com",
			apiKey: "gk-000",
			protocols: [{ protocol: "openai", baseUrl: "https://custom.gemini.com" }],
		});

		const result = await buildAgentProviderEnv("gemini");
		// Gemini has no protocol restrictions, so it uses the provider's protocol (openai)
		expect(result.usesCustomProvider).toBe(true);
		expect(result.env.OPENAI_BASE_URL).toBe("https://custom.gemini.com");
		expect(result.env.OPENAI_API_KEY).toBe("gk-000");
	});

	it("returns empty env when provider protocols are incompatible with agent", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "codex",
			provider: "anthropic-only-provider",
			baseUrl: "https://anthropic-only.example.com",
			apiKey: "sk-anthropic",
			protocols: [{ protocol: "anthropic", baseUrl: "https://anthropic-only.example.com" }],
		});

		// codex supports openai, provider only supports anthropic
		// resolveProtocolEnvVars returns null (no compatible protocol found)
		const result = await buildAgentProviderEnv("codex");
		expect(result.usesCustomProvider).toBe(false);
		expect(result.env).toEqual({});
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
	});
});
