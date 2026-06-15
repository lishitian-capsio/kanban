import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Use vi.hoisted so paths are available before module evaluation (vi.mock hoists).
// Cannot use imported functions inside vi.hoisted — use inline path building.
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
		// Clean up mock ~/.claude dir
		if (existsSync(mockClaudeDir)) {
			rmSync(mockClaudeDir, { recursive: true });
		}
	});

	afterEach(() => {
		// Clean up
		if (existsSync(mockClaudeDir)) {
			rmSync(mockClaudeDir, { recursive: true });
		}
	});

	function readClaudeSettings(): Record<string, unknown> | null {
		if (!existsSync(mockSettingsPath)) return null;
		return JSON.parse(readFileSync(mockSettingsPath, "utf8"));
	}

	it("returns empty env and clears settings when no config is set (official provider)", async () => {
		// Pre-populate settings file
		mkdirSync(mockClaudeDir, { recursive: true });
		writeFileSync(
			mockSettingsPath,
			JSON.stringify({ env: { ANTHROPIC_BASE_URL: "old-url", ANTHROPIC_API_KEY: "old-key" } }),
		);

		// No per-agent config → official provider fallback
		agentProviderMocks.getAgentProviderConfig.mockReturnValue(null);

		const result = await buildAgentProviderEnv("claude");
		expect(result.usesCustomProvider).toBe(false);
		expect(result.env).toEqual({});

		// Settings file should be cleared
		const settings = readClaudeSettings();
		expect(settings?.env).toBeUndefined();
	});

	it("returns empty env when agent has no config", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue(null);

		const result = await buildAgentProviderEnv("claude");
		expect(result.usesCustomProvider).toBe(false);
		expect(result.env).toEqual({});
	});

	it("writes ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY to ~/.claude/settings.json for custom provider", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "claude",
			provider: "custom-aliyun",
			baseUrl: "https://custom.aliyun.com/v1",
			apiKey: "sk-custom-123",
		});

		const result = await buildAgentProviderEnv("claude");
		// No env vars returned (Claude Code uses settings file)
		expect(result.usesCustomProvider).toBe(true);
		expect(result.env).toEqual({});

		// Settings file should have both BASE_URL and API_KEY
		const settings = readClaudeSettings();
		expect(settings).toEqual({
			env: {
				ANTHROPIC_BASE_URL: "https://custom.aliyun.com/v1",
				ANTHROPIC_API_KEY: "sk-custom-123",
			},
		});
	});

	it("preserves existing settings when writing Claude config (with API key)", async () => {
		// Pre-populate with other settings
		mkdirSync(mockClaudeDir, { recursive: true });
		writeFileSync(
			mockSettingsPath,
			JSON.stringify({ env: { ANTHROPIC_MODEL: "claude-opus-4" }, model: "claude-3.5-sonnet" }),
		);

		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "claude",
			provider: "custom-aliyun",
			baseUrl: "https://custom.aliyun.com/v1",
			apiKey: "sk-custom-123",
		});

		await buildAgentProviderEnv("claude");

		const settings = readClaudeSettings();
		expect(settings).toEqual({
			env: {
				ANTHROPIC_MODEL: "claude-opus-4",
				ANTHROPIC_BASE_URL: "https://custom.aliyun.com/v1",
				ANTHROPIC_API_KEY: "sk-custom-123",
			},
			model: "claude-3.5-sonnet",
		});
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

	it("injects ANTHROPIC env vars for droid with custom provider", async () => {
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
		expect(result.env.ANTHROPIC_API_KEY).toBe("dk-789");
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

	it("returns empty env for non-claude agent when protocols are incompatible", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "codex",
			provider: "anthropic-only-provider",
			baseUrl: "https://anthropic-only.example.com",
			apiKey: "sk-anthropic",
			protocols: [{ protocol: "anthropic", baseUrl: "https://anthropic-only.example.com" }],
		});

		// codex supports openai, provider only supports anthropic
		// resolveProtocolEnvVars returns null (no compatible protocol found)
		// So no env vars are injected — correct behavior
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

	it("writes only baseUrl to settings when apiKey is not set", async () => {
		agentProviderMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "claude",
			provider: "custom-no-key",
			baseUrl: "https://no-key.example.com",
		});

		const result = await buildAgentProviderEnv("claude");
		expect(result.usesCustomProvider).toBe(true);
		expect(result.env).toEqual({});

		const settings = readClaudeSettings();
		expect(settings).toEqual({
			env: {
				ANTHROPIC_BASE_URL: "https://no-key.example.com",
			},
		});
	});
});
