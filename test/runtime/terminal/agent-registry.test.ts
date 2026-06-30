import { beforeEach, describe, expect, it, vi } from "vitest";

const commandDiscoveryMocks = vi.hoisted(() => ({
	isBinaryAvailableOnPath: vi.fn(),
	resolveBinaryPathOnPath: vi.fn(),
}));

vi.mock("../../../src/terminal/command-discovery.js", () => ({
	isBinaryAvailableOnPath: commandDiscoveryMocks.isBinaryAvailableOnPath,
	resolveBinaryPathOnPath: commandDiscoveryMocks.resolveBinaryPathOnPath,
}));

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import {
	buildRuntimeConfigResponse,
	detectInstalledCommands,
	resolveAgentCommand,
} from "../../../src/terminal/agent-registry";

function createRuntimeConfigState(overrides: Partial<RuntimeConfigState> = {}): RuntimeConfigState {
	return {
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		proxyEnabled: false,
		proxyHost: "",
		proxyPort: "",
		proxyUsername: "",
		proxyPassword: "",
		noProxy: "",
		...overrides,
	};
}

beforeEach(() => {
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
	commandDiscoveryMocks.resolveBinaryPathOnPath.mockReset();
	commandDiscoveryMocks.resolveBinaryPathOnPath.mockReturnValue(null);
	delete process.env.KANBAN_DEBUG_MODE;
	delete process.env.DEBUG_MODE;
	delete process.env.debug_mode;
});

describe("agent-registry", () => {
	it("detects installed commands from the inherited PATH", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const detected = detectInstalledCommands();

		expect(detected).toEqual(["claude"]);
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledTimes(8);
	});

	it("treats shell-only agents as unavailable", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "npx");

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "claude" }));

		expect(resolved).toBeNull();
	});

	it("resolves the overridden absolute path when the catalog binary is not on PATH", () => {
		// The daemon case: `claude` is not discoverable on PATH, but the user pinned
		// an absolute executable path for it.
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation(
			(binary: string) => binary === "/home/dev/.local/bin/claude",
		);

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "claude" }), (agentId) =>
			agentId === "claude" ? "/home/dev/.local/bin/claude" : undefined,
		);

		expect(resolved).not.toBeNull();
		expect(resolved?.binary).toBe("/home/dev/.local/bin/claude");
		expect(resolved?.command).toBe("/home/dev/.local/bin/claude");
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledWith("/home/dev/.local/bin/claude");
	});

	it("falls back to the catalog binary on PATH when no override is set", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "claude" }), () => undefined);

		expect(resolved?.binary).toBe("claude");
	});

	it("ignores a blank override and resolves the catalog binary", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "claude" }), () => "   ");

		expect(resolved?.binary).toBe("claude");
	});
});

describe("buildRuntimeConfigResponse", () => {
	it("keeps curated agent default args independent of autonomous mode", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: true,
		});

		const response = buildRuntimeConfigResponse(config, {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.agentAutonomousModeEnabled).toBe(true);
		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "pi", "droid", "kiro"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "pi")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "droid")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "kiro")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "pi")?.installed).toBe(true);
	});

	it("omits autonomous flags from curated agent commands when disabled", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: false,
		});
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const response = buildRuntimeConfigResponse(config, {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.agentAutonomousModeEnabled).toBe(false);
		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "pi", "droid", "kiro"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "pi")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "droid")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "kiro")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "pi")?.installed).toBe(true);
		expect(response.agents.find((agent) => agent.id === "claude")?.command).toBe("claude");
		expect(response.agents.find((agent) => agent.id === "codex")?.command).toBe("codex");
		expect(response.agents.find((agent) => agent.id === "droid")?.command).toBe("droid");
		expect(response.agents.find((agent) => agent.id === "kiro")?.command).toBe("kiro-cli chat");
	});

	it("marks an agent installed via its overridden absolute path", () => {
		// `claude` is not on PATH, only the pinned absolute path is executable.
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation(
			(binary: string) => binary === "/opt/tools/claude",
		);
		commandDiscoveryMocks.resolveBinaryPathOnPath.mockImplementation((binary: string) =>
			binary === "/opt/tools/claude" ? "/opt/tools/claude" : null,
		);

		const response = buildRuntimeConfigResponse(
			createRuntimeConfigState({ selectedAgentId: "claude" }),
			{
				providerId: null,
				modelId: null,
				baseUrl: null,
				apiKeyConfigured: false,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			},
			(agentId) => (agentId === "claude" ? "/opt/tools/claude" : undefined),
		);

		const claude = response.agents.find((agent) => agent.id === "claude");
		expect(claude?.installed).toBe(true);
		expect(claude?.binary).toBe("/opt/tools/claude");
		expect(claude?.command).toBe("/opt/tools/claude");
		// The resolved launch path surfaces the override's on-disk location.
		expect(claude?.resolvedExecutablePath).toBe("/opt/tools/claude");
		// An agent without an override stays driven by PATH discovery (here: not found).
		expect(response.agents.find((agent) => agent.id === "codex")?.installed).toBe(false);
		expect(response.agents.find((agent) => agent.id === "codex")?.resolvedExecutablePath).toBeNull();
	});

	it("surfaces the resolved $PATH location for a detected catalog binary", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");
		commandDiscoveryMocks.resolveBinaryPathOnPath.mockImplementation((binary: string) =>
			binary === "claude" ? "/usr/local/bin/claude" : null,
		);

		const response = buildRuntimeConfigResponse(createRuntimeConfigState({ selectedAgentId: "claude" }), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		const claude = response.agents.find((agent) => agent.id === "claude");
		expect(claude?.installed).toBe(true);
		expect(claude?.resolvedExecutablePath).toBe("/usr/local/bin/claude");
		// The native pi agent has no CLI binary, so no resolved path.
		expect(response.agents.find((agent) => agent.id === "pi")?.resolvedExecutablePath).toBeNull();
	});

	it("sets debug mode from runtime environment variables", () => {
		process.env.KANBAN_DEBUG_MODE = "true";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.debugModeEnabled).toBe(true);
	});

	it("supports debug_mode fallback env name", () => {
		process.env.debug_mode = "1";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.debugModeEnabled).toBe(true);
	});
});
