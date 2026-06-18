import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A throwaway temp root used both as the isolated CODEX_HOME base dir and as the
// fake $HOME, so we can assert the projector NEVER writes the real ~/.codex.
const { tmpRoot, fakeHome } = vi.hoisted(() => {
	const tmpBase = process.env.TMPDIR ?? process.env.TMP ?? "/tmp";
	const root = `${tmpBase}/kanban-codex-home-test-${Date.now()}`;
	return { tmpRoot: root, fakeHome: `${root}/home` };
});

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => fakeHome };
});

// Mock the machine-home so the default base dir lands inside our temp root.
vi.mock("../../../src/state/workspace-state", () => ({
	getMachineKanbanHomePath: () => join(fakeHome, ".kanban"),
}));

// Mock the provider store the resolver reads from (same seam as env-injector.test).
const providerMocks = vi.hoisted(() => ({
	getAgentProviderConfig: vi.fn(),
	getAgentProviderSet: vi.fn(),
}));

vi.mock("../../../src/agent-sdk/kanban/agent-provider-config", () => ({
	getAgentProviderConfig: providerMocks.getAgentProviderConfig,
	getAgentProviderSet: providerMocks.getAgentProviderSet,
	normalizeProviderId: (id: string | undefined | null) => (id ?? "").trim().toLowerCase(),
}));

import { projectCodexHome, renderCodexConfigToml } from "../../../src/terminal/codex-home-projector";

describe("renderCodexConfigToml", () => {
	it("renders a third-party OpenAI provider using the Responses wire API", () => {
		const toml = renderCodexConfigToml({
			provider: {
				id: "my-relay",
				name: "My Relay",
				baseUrl: "https://relay.example.com/v1",
				wireApi: "responses",
				envKey: "OPENAI_API_KEY",
			},
			model: "gpt-5-codex",
			reasoningEffort: "high",
			preferredAuthMethod: "apikey",
		});

		expect(toml).toContain(`model_provider = "my-relay"`);
		expect(toml).toContain(`model = "gpt-5-codex"`);
		expect(toml).toContain(`model_reasoning_effort = "high"`);
		expect(toml).toContain(`preferred_auth_method = "apikey"`);
		expect(toml).toContain(`[model_providers.my-relay]`);
		expect(toml).toContain(`name = "My Relay"`);
		expect(toml).toContain(`base_url = "https://relay.example.com/v1"`);
		expect(toml).toContain(`wire_api = "responses"`);
		// The secret is referenced by env var name, never embedded.
		expect(toml).toContain(`env_key = "OPENAI_API_KEY"`);
	});

	it("emits context window + auto-compact limit as bare integers when provided", () => {
		const toml = renderCodexConfigToml({
			provider: {
				id: "relay",
				name: "relay",
				baseUrl: "https://relay.example.com/v1",
				wireApi: "responses",
				envKey: "OPENAI_API_KEY",
			},
			contextWindow: 272000,
			autoCompactTokenLimit: 240000,
		});

		expect(toml).toContain(`model_context_window = 272000`);
		expect(toml).toContain(`model_auto_compact_token_limit = 240000`);
		// Integers must not be quoted.
		expect(toml).not.toContain(`model_context_window = "272000"`);
	});

	it("explicitly disables reasoning summaries for providers that don't support them", () => {
		const toml = renderCodexConfigToml({
			provider: {
				id: "relay",
				name: "relay",
				baseUrl: "https://relay.example.com/v1",
				wireApi: "responses",
				envKey: "OPENAI_API_KEY",
			},
			reasoningSummary: "none",
			supportsReasoningSummaries: false,
		});

		expect(toml).toContain(`model_reasoning_summary = "none"`);
		expect(toml).toContain(`model_supports_reasoning_summaries = false`);
	});

	it("omits optional top-level keys when not provided", () => {
		const toml = renderCodexConfigToml({
			provider: {
				id: "relay",
				name: "relay",
				baseUrl: "https://relay.example.com/v1",
				wireApi: "chat",
				envKey: "OPENAI_API_KEY",
			},
		});

		expect(toml).not.toContain("model =");
		expect(toml).not.toContain("model_reasoning_effort");
		expect(toml).not.toContain("model_context_window");
		expect(toml).not.toContain("model_supports_reasoning_summaries");
		expect(toml).not.toContain("preferred_auth_method");
		expect(toml).toContain(`wire_api = "chat"`);
	});

	it("quotes a provider id in the table header when it isn't a bare TOML key", () => {
		const toml = renderCodexConfigToml({
			provider: {
				id: "weird id",
				name: "weird id",
				baseUrl: "https://relay.example.com/v1",
				wireApi: "responses",
				envKey: "OPENAI_API_KEY",
			},
		});

		expect(toml).toContain(`[model_providers."weird id"]`);
	});

	it("escapes double quotes and backslashes inside string values", () => {
		const toml = renderCodexConfigToml({
			provider: {
				id: "relay",
				name: 'A "quoted" \\ name',
				baseUrl: "https://relay.example.com/v1",
				wireApi: "responses",
				envKey: "OPENAI_API_KEY",
			},
		});

		expect(toml).toContain(`name = "A \\"quoted\\" \\\\ name"`);
	});
});

describe("projectCodexHome", () => {
	beforeEach(() => {
		providerMocks.getAgentProviderConfig.mockReset();
		providerMocks.getAgentProviderSet.mockReset();
		providerMocks.getAgentProviderSet.mockReturnValue(null);
		if (existsSync(tmpRoot)) {
			rmSync(tmpRoot, { recursive: true });
		}
	});

	afterEach(() => {
		if (existsSync(tmpRoot)) {
			rmSync(tmpRoot, { recursive: true });
		}
	});

	const baseDir = () => join(tmpRoot, "codex-home");

	it("generates an isolated CODEX_HOME with a config.toml for a custom OpenAI provider", async () => {
		providerMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "codex",
			provider: "my-relay",
			model: "gpt-5-codex",
			apiKey: "sk-secret-should-not-be-written",
			protocols: [{ protocol: "openai", baseUrl: "https://relay.example.com/v1" }],
		});

		const result = await projectCodexHome({
			agentId: "codex",
			taskId: "task-123",
			baseDir: baseDir(),
		});

		expect(result).not.toBeNull();
		const codexHome = result?.codexHome ?? "";
		expect(codexHome).toBe(join(baseDir(), "task-123"));
		expect(result?.env.CODEX_HOME).toBe(codexHome);

		const configPath = join(codexHome, "config.toml");
		expect(existsSync(configPath)).toBe(true);
		const toml = readFileSync(configPath, "utf8");
		expect(toml).toContain(`base_url = "https://relay.example.com/v1"`);
		expect(toml).toContain(`wire_api = "responses"`);
		expect(toml).toContain(`env_key = "OPENAI_API_KEY"`);
		expect(toml).toContain(`model = "gpt-5-codex"`);
		// The secret must never be persisted to the config.
		expect(toml).not.toContain("sk-secret-should-not-be-written");
	});

	it("defaults to the Responses API and disables reasoning summaries for third-party providers", async () => {
		providerMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "codex",
			provider: "my-relay",
			apiKey: "sk-x",
			protocols: [{ protocol: "openai", baseUrl: "https://relay.example.com/v1" }],
		});

		const result = await projectCodexHome({
			agentId: "codex",
			taskId: "task-abc",
			baseDir: baseDir(),
		});

		const toml = readFileSync(join(result?.codexHome ?? "", "config.toml"), "utf8");
		expect(toml).toContain(`wire_api = "responses"`);
		expect(toml).toContain(`model_reasoning_summary = "none"`);
		expect(toml).toContain(`model_supports_reasoning_summaries = false`);
		expect(toml).toContain(`preferred_auth_method = "apikey"`);
	});

	it("returns null for official login and writes nothing (native ~/.codex preserved)", async () => {
		providerMocks.getAgentProviderSet.mockReturnValue({
			agentId: "codex",
			providers: [
				{
					agentId: "codex",
					provider: "my-relay",
					apiKey: "sk-x",
					protocols: [{ protocol: "openai", baseUrl: "https://relay.example.com/v1" }],
				},
			],
			defaultProviderId: "official",
		});

		const result = await projectCodexHome({
			agentId: "codex",
			taskId: "task-official",
			baseDir: baseDir(),
		});

		expect(result).toBeNull();
		expect(existsSync(join(baseDir(), "task-official"))).toBe(false);
		// The store config must not even be consulted on the official path.
		expect(providerMocks.getAgentProviderConfig).not.toHaveBeenCalled();
	});

	it("returns null when the agent has no custom provider configured", async () => {
		providerMocks.getAgentProviderConfig.mockReturnValue(null);

		const result = await projectCodexHome({
			agentId: "codex",
			taskId: "task-none",
			baseDir: baseDir(),
		});

		expect(result).toBeNull();
		expect(existsSync(join(baseDir(), "task-none"))).toBe(false);
	});

	it("throws when the resolved provider speaks a protocol codex cannot use", async () => {
		providerMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "codex",
			provider: "anthropic-only",
			apiKey: "sk-x",
			protocols: [{ protocol: "anthropic", baseUrl: "https://anthropic-only.example.com" }],
		});

		await expect(projectCodexHome({ agentId: "codex", taskId: "task-bad", baseDir: baseDir() })).rejects.toThrow(
			/cannot use/i,
		);
	});

	it("never writes the real ~/.codex directory", async () => {
		providerMocks.getAgentProviderConfig.mockReturnValue({
			agentId: "codex",
			provider: "my-relay",
			apiKey: "sk-x",
			protocols: [{ protocol: "openai", baseUrl: "https://relay.example.com/v1" }],
		});

		await projectCodexHome({ agentId: "codex", taskId: "task-iso", baseDir: baseDir() });

		expect(existsSync(join(fakeHome, ".codex"))).toBe(false);
	});
});
