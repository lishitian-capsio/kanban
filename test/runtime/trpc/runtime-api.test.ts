import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
	buildRuntimeConfigResponse: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
}));

const oauthMocks = vi.hoisted(() => ({
	addLocalProvider: vi.fn(),
	ensureCustomProvidersLoaded: vi.fn(),
	getValidKanbanCredentials: vi.fn(),
	getValidOcaCredentials: vi.fn(),
	getValidOpenAICodexCredentials: vi.fn(),
	loginKanbanOAuth: vi.fn(),
	loginOcaOAuth: vi.fn(),
	loginOpenAICodex: vi.fn(),
	resolveDefaultMcpSettingsPath: vi.fn(),
	resolveKanbanDataDir: vi.fn(() => "/tmp/kanban"),
	loadMcpSettingsFile: vi.fn(),
	saveProviderSettings: vi.fn(),
	getProviderSettings: vi.fn(),
	getLastUsedProviderSettings: vi.fn(),
	getAllProviders: vi.fn(() => ({})),
	deleteProviderSettings: vi.fn(),
}));

const llmsModelMocks = vi.hoisted(() => ({
	getAllProviders: vi.fn(),
	getModelsForProvider: vi.fn(),
	resolveProviderConfig: vi.fn(),
	resolveProviderModelCatalogKeys: vi.fn(),
}));

const localProviderMocks = vi.hoisted(() => ({
	getLocalProviderModels: vi.fn(),
}));

const kanbanAccountMocks = vi.hoisted(() => ({
	fetchMe: vi.fn(),
	fetchRemoteConfig: vi.fn(),
	fetchOrganization: vi.fn(),
	fetchFeaturebaseToken: vi.fn(),
	constructedOptions: [] as Array<{ apiBaseUrl: string; getAuthToken: () => Promise<string | undefined | null> }>,
}));

const piProviderConfigMocks = vi.hoisted(() => ({
	resolvePiLaunchConfig: vi.fn(),
	resolvePiModel: vi.fn(),
	listPiProviders: vi.fn(() => []),
	PI_DEFAULT_PROVIDER_ID: "anthropic",
	PI_DEFAULT_MODEL_ID: "claude-sonnet-4-20250514",
	toOmpEffort: vi.fn(),
}));

const browserMocks = vi.hoisted(() => ({
	openInBrowser: vi.fn(),
}));

vi.mock("../../../src/terminal/agent-registry.js", () => ({
	resolveAgentCommand: agentRegistryMocks.resolveAgentCommand,
	buildRuntimeConfigResponse: agentRegistryMocks.buildRuntimeConfigResponse,
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
}));

vi.mock("@clinebot/core", () => ({
	addLocalProvider: oauthMocks.addLocalProvider,
	ensureCustomProvidersLoaded: oauthMocks.ensureCustomProvidersLoaded,
	getLocalProviderModels: localProviderMocks.getLocalProviderModels,
	getValidKanbanCredentials: oauthMocks.getValidKanbanCredentials,
	getValidOcaCredentials: oauthMocks.getValidOcaCredentials,
	getValidOpenAICodexCredentials: oauthMocks.getValidOpenAICodexCredentials,
	loginKanbanOAuth: oauthMocks.loginKanbanOAuth,
	loginOcaOAuth: oauthMocks.loginOcaOAuth,
	loginOpenAICodex: oauthMocks.loginOpenAICodex,
	resolveDefaultMcpSettingsPath: oauthMocks.resolveDefaultMcpSettingsPath,
	resolveKanbanDataDir: oauthMocks.resolveKanbanDataDir,
	loadMcpSettingsFile: oauthMocks.loadMcpSettingsFile,
	resolveProviderConfig: llmsModelMocks.resolveProviderConfig,
	KanbanAccountService: class {
		constructor(options: { apiBaseUrl: string; getAuthToken: () => Promise<string | undefined | null> }) {
			kanbanAccountMocks.constructedOptions.push(options);
		}
		fetchMe = kanbanAccountMocks.fetchMe;
		fetchRemoteConfig = kanbanAccountMocks.fetchRemoteConfig;
		fetchOrganization = kanbanAccountMocks.fetchOrganization;
		fetchFeaturebaseToken = kanbanAccountMocks.fetchFeaturebaseToken;
	},
	ProviderSettingsManager: class {
		saveProviderSettings = oauthMocks.saveProviderSettings;
		getProviderSettings = oauthMocks.getProviderSettings;
		getLastUsedProviderSettings = oauthMocks.getLastUsedProviderSettings;
		getProviderConfig = vi.fn((providerId: string) => {
			const settings = oauthMocks.getProviderSettings(providerId);
			if (!settings) {
				return undefined;
			}
			return {
				providerId: settings.provider,
				apiKey: settings.apiKey,
				modelId: settings.model,
				baseUrl: settings.baseUrl,
			};
		});
	},
	Llms: {
		getAllProviders: llmsModelMocks.getAllProviders,
		getModelsForProvider: llmsModelMocks.getModelsForProvider,
		resolveProviderModelCatalogKeys: llmsModelMocks.resolveProviderModelCatalogKeys,
	},
	LlmsModels: {
		CLINE_DEFAULT_MODEL: "anthropic/claude-sonnet-4.6",
		getAllProviders: llmsModelMocks.getAllProviders,
		getModelsForProvider: llmsModelMocks.getModelsForProvider,
	},
}));

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: browserMocks.openInBrowser,
}));

vi.mock("../../../src/agent-sdk/kanban/pi-provider-config.js", () => ({
	resolvePiLaunchConfig: (...args: unknown[]) => piProviderConfigMocks.resolvePiLaunchConfig(...args),
	resolvePiModel: (...args: unknown[]) => piProviderConfigMocks.resolvePiModel(...args),
	listPiProviders: () => piProviderConfigMocks.listPiProviders(),
	PI_DEFAULT_PROVIDER_ID: "anthropic",
	PI_DEFAULT_MODEL_ID: "claude-sonnet-4-20250514",
	toOmpEffort: (...args: unknown[]) => piProviderConfigMocks.toOmpEffort(...args),
}));

// The omp provider service reads selected/custom provider settings from the
// on-disk omp store. Mock it and route every read/write back through the
// shared `oauthMocks` so the `setSelectedProviderSettings` helper drives the
// pi code path too, and so tests never touch the real `~/.kanban` store.
vi.mock("../../../src/agent-sdk/kanban/provider-settings-store.js", () => ({
	getProviderSettings: (providerId: string) => oauthMocks.getProviderSettings(providerId) ?? null,
	getLastUsedProviderSettings: () => oauthMocks.getLastUsedProviderSettings() ?? null,
	getLastUsedProviderId: () => oauthMocks.getLastUsedProviderSettings()?.provider ?? null,
	getAllProviders: () => oauthMocks.getAllProviders(),
	saveProviderSettings: (input: unknown) => oauthMocks.saveProviderSettings(input),
	deleteProviderSettings: (providerId: string) => oauthMocks.deleteProviderSettings(providerId),
	resetProviderSettingsCache: vi.fn(),
}));

import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";

function createTestRuntimeApi(
	deps: Omit<CreateRuntimeApiDependencies, "getUpdateStatus" | "runUpdateNow"> &
		Partial<Pick<CreateRuntimeApiDependencies, "getUpdateStatus" | "runUpdateNow">>,
): RuntimeTrpcContext["runtimeApi"] {
	return createRuntimeApi({
		...deps,
		getUpdateStatus:
			deps.getUpdateStatus ??
			vi.fn(() => ({
				currentVersion: "0.1.0",
				latestVersion: null,
				updateAvailable: false,
				updateTiming: null,
				installCommand: null,
			})),
		runUpdateNow:
			deps.runUpdateNow ??
			vi.fn(async () => ({
				status: "unsupported_installation" as const,
				currentVersion: "0.1.0",
				latestVersion: null,
				message: "On-demand updates are not available in this test runtime.",
			})),
	});
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createRuntimeConfigState(): RuntimeConfigState {
	return {
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		proxyEnabled: false,
		proxyHost: "",
		proxyPort: "",
		proxyUsername: "",
		proxyPassword: "",
		noProxy: "",
	};
}

function setSelectedProviderSettings(
	settings: {
		provider: string;
		model?: string;
		baseUrl?: string;
		apiKey?: string;
		reasoning?: {
			effort?: "low" | "medium" | "high" | "xhigh";
		};
		auth?: {
			accessToken?: string;
			refreshToken?: string;
			accountId?: string;
			expiresAt?: number;
		};
	} | null,
): void {
	oauthMocks.getLastUsedProviderSettings.mockReturnValue(settings ?? undefined);
	oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
		settings && settings.provider === providerId ? settings : undefined,
	);
}

function restoreEnvVar(name: "KANBAN_API_KEY" | "OCA_API_KEY", value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function createPiTaskSessionServiceMock() {
	return {
		startTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary>>(async () =>
			createSummary({ agentId: "pi", pid: null }),
		),
		onMessage: vi.fn<(...args: unknown[]) => () => void>(() => () => {}),
		stopTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		abortTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		cancelTaskTurn: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		sendTaskSessionInput: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		clearTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		reloadTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		rebindPersistedTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(
			async () => null,
		),
		getSummary: vi.fn<(...args: unknown[]) => RuntimeTaskSessionSummary | null>(() => null),
		listSummaries: vi.fn<(...args: unknown[]) => RuntimeTaskSessionSummary[]>(() => []),
		listMessages: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
		loadTaskSessionMessages: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
		applyTurnCheckpoint: vi.fn<(...args: unknown[]) => RuntimeTaskSessionSummary | null>(() => null),
		dispose: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
	};
}

describe("createRuntimeApi startTaskSession", () => {
	const originalKanbanApiKey = process.env.KANBAN_API_KEY;
	const originalOcaApiKey = process.env.OCA_API_KEY;
	const originalKanbanMcpSettingsPath = process.env.KANBAN_MCP_SETTINGS_PATH;
	const originalKanbanMcpOauthSettingsPath = process.env.KANBAN_MCP_OAUTH_SETTINGS_PATH;
	let mcpSettingsPath = "";
	let mcpOauthSettingsPath = "";

	beforeEach(() => {
		mcpSettingsPath = `/tmp/kanban-mcp-settings-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
		mcpOauthSettingsPath = `/tmp/kanban-mcp-oauth-settings-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
		process.env.KANBAN_MCP_SETTINGS_PATH = mcpSettingsPath;
		process.env.KANBAN_MCP_OAUTH_SETTINGS_PATH = mcpOauthSettingsPath;
		agentRegistryMocks.resolveAgentCommand.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		oauthMocks.addLocalProvider.mockReset();
		oauthMocks.ensureCustomProvidersLoaded.mockReset();
		oauthMocks.loginKanbanOAuth.mockReset();
		oauthMocks.loginOcaOAuth.mockReset();
		oauthMocks.loginOpenAICodex.mockReset();
		oauthMocks.getValidKanbanCredentials.mockReset();
		oauthMocks.getValidOcaCredentials.mockReset();
		oauthMocks.getValidOpenAICodexCredentials.mockReset();
		oauthMocks.resolveDefaultMcpSettingsPath.mockReset();
		oauthMocks.loadMcpSettingsFile.mockReset();
		oauthMocks.saveProviderSettings.mockReset();
		oauthMocks.getProviderSettings.mockReset();
		oauthMocks.getLastUsedProviderSettings.mockReset();
		oauthMocks.getAllProviders.mockReset();
		oauthMocks.getAllProviders.mockReturnValue({});
		oauthMocks.deleteProviderSettings.mockReset();
		kanbanAccountMocks.fetchMe.mockReset();
		kanbanAccountMocks.fetchRemoteConfig.mockReset();
		kanbanAccountMocks.constructedOptions.length = 0;
		localProviderMocks.getLocalProviderModels.mockReset();
		llmsModelMocks.getAllProviders.mockReset();
		llmsModelMocks.getModelsForProvider.mockReset();
		llmsModelMocks.resolveProviderConfig.mockReset();
		llmsModelMocks.resolveProviderModelCatalogKeys.mockReset();
		browserMocks.openInBrowser.mockReset();

		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "claude",
			args: [],
		});
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockResolvedValue({
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		});
		oauthMocks.loginKanbanOAuth.mockResolvedValue({
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: 1_700_000_000_000,
			accountId: "acct-1",
		});
		oauthMocks.loginOcaOAuth.mockResolvedValue({
			access: "oca-access",
			refresh: "oca-refresh",
			expires: 1_700_000_000_000,
			accountId: "oca-acct",
		});
		oauthMocks.loginOpenAICodex.mockResolvedValue({
			access: "codex-access",
			refresh: "codex-refresh",
			expires: 1_700_000_000_000,
			accountId: "codex-acct",
		});
		oauthMocks.getValidKanbanCredentials.mockResolvedValue({
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: 1_700_000_000_000,
			accountId: "acct-1",
		});
		oauthMocks.getValidOcaCredentials.mockResolvedValue({
			access: "oca-access",
			refresh: "oca-refresh",
			expires: 1_700_000_000_000,
			accountId: "oca-acct",
		});
		oauthMocks.getValidOpenAICodexCredentials.mockResolvedValue({
			access: "codex-access",
			refresh: "codex-refresh",
			expires: 1_700_000_000_000,
			accountId: "codex-acct",
		});
		oauthMocks.addLocalProvider.mockResolvedValue({
			providerId: "custom-provider",
			settingsPath: "/tmp/providers.json",
			modelsPath: "/tmp/models.json",
			modelsCount: 1,
		});
		oauthMocks.ensureCustomProvidersLoaded.mockResolvedValue(undefined);
		llmsModelMocks.getAllProviders.mockResolvedValue([]);
		llmsModelMocks.getModelsForProvider.mockResolvedValue({});
		llmsModelMocks.resolveProviderConfig.mockResolvedValue(undefined);
		llmsModelMocks.resolveProviderModelCatalogKeys.mockImplementation((providerId: string) =>
			providerId === "cline" ? ["openrouter", "cline"] : [providerId],
		);
		oauthMocks.resolveDefaultMcpSettingsPath.mockReturnValue(mcpSettingsPath);
		oauthMocks.loadMcpSettingsFile.mockReturnValue({
			mcpServers: {},
		});
		kanbanAccountMocks.fetchMe.mockResolvedValue({
			id: "acct-1",
			email: "saoud@example.com",
			displayName: "Saoud",
		});
		kanbanAccountMocks.fetchRemoteConfig.mockResolvedValue({
			organizationId: "org-1",
			enabled: true,
			value: JSON.stringify({
				kanbanEnabled: true,
			}),
		});
		setSelectedProviderSettings(null);
		piProviderConfigMocks.resolvePiLaunchConfig.mockImplementation(
			(input?: { providerIdOverride?: string | null; modelIdOverride?: string | null; reasoningEffortOverride?: unknown }) => {
				const providerId = input?.providerIdOverride?.trim() || "anthropic";
				const modelId = input?.modelIdOverride?.trim() || "claude-sonnet-4-20250514";
				const settings = oauthMocks.getProviderSettings(providerId) ?? oauthMocks.getLastUsedProviderSettings();
				let apiKey: string | null = settings?.apiKey ?? null;
				const baseUrl: string | null = settings?.baseUrl ?? null;
				if (providerId === "cline" && settings?.auth?.accessToken) {
					apiKey = `workos:${settings.auth.accessToken}`;
				}
				if (!apiKey) {
					const envVarName = providerId === "anthropic" ? "ANTHROPIC_API_KEY"
						: providerId === "openai" ? "OPENAI_API_KEY"
						: providerId === "cline" ? "KANBAN_API_KEY"
						: `${providerId.toUpperCase()}_API_KEY`;
					apiKey = process.env[envVarName] ?? null;
				}
				return {
					providerId,
					modelId,
					apiKey,
					baseUrl,
					reasoningEffort: input?.reasoningEffortOverride ?? null,
				};
			},
		);
		llmsModelMocks.getAllProviders.mockResolvedValue([
			{
				id: "cline",
				name: "Kanban",
				defaultModelId: "claude-sonnet-4-6",
				capabilities: ["oauth"],
			},
			{
				id: "anthropic",
				name: "Anthropic",
				defaultModelId: "claude-sonnet-4-6",
				capabilities: ["tools"],
			},
		]);
		llmsModelMocks.getModelsForProvider.mockImplementation(async (providerId: string) => {
			if (providerId !== "cline") {
				return {};
			}
			return {
				"claude-sonnet-4-6": {
					id: "claude-sonnet-4-6",
					name: "Claude Sonnet 4.6",
					capabilities: ["images", "files"],
				},
			};
		});
	});

	afterEach(() => {
		restoreEnvVar("KANBAN_API_KEY", originalKanbanApiKey);
		restoreEnvVar("OCA_API_KEY", originalOcaApiKey);
		if (originalKanbanMcpSettingsPath === undefined) {
			delete process.env.KANBAN_MCP_SETTINGS_PATH;
		} else {
			process.env.KANBAN_MCP_SETTINGS_PATH = originalKanbanMcpSettingsPath;
		}
		if (originalKanbanMcpOauthSettingsPath === undefined) {
			delete process.env.KANBAN_MCP_OAUTH_SETTINGS_PATH;
		} else {
			process.env.KANBAN_MCP_OAUTH_SETTINGS_PATH = originalKanbanMcpOauthSettingsPath;
		}
		rmSync(mcpSettingsPath, { force: true });
		rmSync(`${mcpSettingsPath}.lock`, { force: true });
		rmSync(mcpOauthSettingsPath, { force: true });
		rmSync(`${mcpOauthSettingsPath}.lock`, { force: true });
	});

	it("reuses an existing worktree path before falling back to ensure", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledTimes(1);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/existing-worktree",
			}),
		);
	});

	it("ensures the worktree when no existing task cwd is available", async () => {
		taskWorktreeMocks.resolveTaskCwd
			.mockRejectedValueOnce(new Error("missing"))
			.mockResolvedValueOnce("/tmp/new-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenNthCalledWith(1, {
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenNthCalledWith(2, {
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: true,
		});
	});

	it("routes pi start sessions to pi task session service", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		setSelectedProviderSettings({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "anthropic-api-key",
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "pi", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "pi";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
				startInPlanMode: true,
			},
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				cwd: "/tmp/existing-worktree",
				prompt: "Continue task",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
				providerId: "anthropic",
				apiKey: "anthropic-api-key",
				mode: "act",
				startInPlanMode: true,
				resumeFromTrash: undefined,
			}),
		);
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("applies task-level reasoning overrides even without task model/provider overrides", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		setSelectedProviderSettings({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "anthropic-api-key",
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "pi", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "pi";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Reasoning-only override task",
				agentSettings: {
					reasoningEffort: "medium",
				},
			},
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-20250514",
				reasoningEffort: "medium",
			}),
		);
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("uses model-default reasoning when a task overrides the model but leaves reasoning on default", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		setSelectedProviderSettings({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "anthropic-api-key",
			reasoning: {
				effort: "high",
			},
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "pi", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "pi";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Task with model override",
				agentSettings: {
					modelId: "anthropic/claude-opus-4.6",
				},
			},
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				modelId: "anthropic/claude-opus-4.6",
				reasoningEffort: null,
			}),
		);
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("clears task chat cache before resumeFromTrash starts", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});

		const broadcastTaskChatCleared = vi.fn();
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ agentId: "codex", state: "idle", pid: null })),
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			broadcastTaskChatCleared,
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Resume task",
				resumeFromTrash: true,
			},
		);

		expect(response.ok).toBe(true);
		expect(broadcastTaskChatCleared).toHaveBeenCalledWith("workspace-1", "task-1");
	});

	it("uses saved cline settings even when no last-used provider is recorded", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		oauthMocks.getLastUsedProviderSettings.mockReturnValue(undefined);
		oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
			providerId === "cline"
				? {
						provider: "cline",
						model: "anthropic/claude-opus-4.6",
						apiKey: "saved-cline-api-key",
					}
				: undefined,
		);

		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "pi", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "pi";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(
				async () => ({ startTaskSession: vi.fn(), applyTurnCheckpoint: vi.fn() }) as never,
			),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				agentSettings: {
					providerId: "cline",
					modelId: "anthropic/claude-opus-4.6",
				},
			},
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "cline",
				modelId: "anthropic/claude-opus-4.6",
				apiKey: "saved-cline-api-key",
			}),
		);
	});

	it("launches pi session with null apiKey when cline provider is selected without credentials", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		delete process.env.KANBAN_API_KEY;
		setSelectedProviderSettings({
			provider: "cline",
			model: "anthropic/claude-opus-4.6",
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "pi", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "pi";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				agentSettings: { providerId: "cline", modelId: "anthropic/claude-opus-4.6" },
			},
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "cline",
				apiKey: null,
			}),
		);
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("allows the cline provider to launch when KANBAN_API_KEY is present in the environment", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		process.env.KANBAN_API_KEY = "env-cline-api-key";
		setSelectedProviderSettings({
			provider: "cline",
			model: "anthropic/claude-opus-4.6",
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "pi", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "pi";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				agentSettings: { providerId: "cline" },
			},
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "cline",
				apiKey: "env-cline-api-key",
			}),
		);
	});

	it("starts home agent sessions in the workspace root without resolving a task worktree", async () => {
		const homeTaskId = "__home_agent__:workspace-1:codex";
		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ taskId: homeTaskId })),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: homeTaskId,
				baseRef: "main",
				prompt: "",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: homeTaskId,
				cwd: "/tmp/repo",
			}),
		);
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
	});

	it("forwards task images to CLI task sessions", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const images = [
			{
				id: "img-1",
				data: Buffer.from("hello").toString("base64"),
				mimeType: "image/png",
				name: "diagram.png",
			},
		];

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				images,
			},
		);

		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				images,
			}),
		);
		expect(piTaskSessionService.startTaskSession).not.toHaveBeenCalled();
	});

	it("does not resolve cline OAuth when starting a non-cline task session", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});
		oauthMocks.getValidKanbanCredentials.mockRejectedValue(
			new Error('OAuth credentials for provider "cline" are invalid. Re-run OAuth login.'),
		);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
			},
		);

		expect(response.ok).toBe(true);
		expect(oauthMocks.getValidKanbanCredentials).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				cwd: "/tmp/existing-worktree",
			}),
		);
		expect(piTaskSessionService.startTaskSession).not.toHaveBeenCalled();
	});

	it("prefers OAuth api key when cline OAuth credentials are configured", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "pi", pid: null }));
		setSelectedProviderSettings({
			provider: "cline",
			model: "claude-sonnet-4-6",
			auth: {
				accessToken: "oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "pi";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				agentSettings: { providerId: "cline" },
			},
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "workos:oauth-access",
			}),
		);
		expect(kanbanAccountMocks.fetchMe).not.toHaveBeenCalled();
	});

	it("does not use OAuth credentials for non-OAuth providers", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "pi", pid: null }));
		setSelectedProviderSettings({
			provider: "anthropic",
			apiKey: "anthropic-api-key",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				expiresAt: 1_700_000_000_000,
			},
		});

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "pi";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
			},
		);

		expect(response.ok).toBe(true);
		expect(oauthMocks.getValidKanbanCredentials).not.toHaveBeenCalled();
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				apiKey: "anthropic-api-key",
			}),
		);
		expect(oauthMocks.saveProviderSettings).not.toHaveBeenCalled();
	});

	it("routes task input and stop to pi task session service", async () => {
		const summary = createSummary({ agentId: "pi", pid: null });
		const terminalManager = {
			writeInput: vi.fn(),
			stopTaskSession: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.sendTaskSessionInput.mockResolvedValue(summary);
		piTaskSessionService.stopTaskSession.mockResolvedValue(summary);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const sendResponse = await api.sendTaskSessionInput(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", text: "hello", appendNewline: true },
		);
		expect(sendResponse.ok).toBe(true);
		expect(piTaskSessionService.sendTaskSessionInput).toHaveBeenCalledWith("task-1", "hello\n");
		expect(terminalManager.writeInput).not.toHaveBeenCalled();

		const stopResponse = await api.stopTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);
		expect(stopResponse.ok).toBe(true);
		expect(piTaskSessionService.stopTaskSession).toHaveBeenCalledWith("task-1");
		expect(terminalManager.stopTaskSession).not.toHaveBeenCalled();
	});

	it("returns chat messages and sends through pi service", async () => {
		const summary = createSummary({ agentId: "pi", pid: null });
		const latestMessage = {
			id: "message-1",
			role: "user" as const,
			content: "hello",
			createdAt: Date.now(),
		};
		const terminalManager = {
			writeInput: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.sendTaskSessionInput.mockResolvedValue(summary);
		piTaskSessionService.listMessages.mockReturnValue([latestMessage]);
		piTaskSessionService.loadTaskSessionMessages.mockResolvedValue([latestMessage]);
		piTaskSessionService.getSummary.mockReturnValue(summary);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const sendResponse = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", text: "hello" },
		);
		expect(sendResponse.ok).toBe(true);
		expect(piTaskSessionService.sendTaskSessionInput).toHaveBeenCalledWith(
			"task-1",
			"hello",
			undefined,
			undefined,
		);
		expect(sendResponse.message).toEqual(latestMessage);

		const messagesResponse = await api.getTaskChatMessages(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);
		expect(messagesResponse.ok).toBe(true);
		expect(messagesResponse.messages).toEqual([latestMessage]);

		piTaskSessionService.abortTaskSession.mockResolvedValue(summary);
		const abortResponse = await api.abortTaskChatTurn(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);
		expect(abortResponse.ok).toBe(true);
		expect(piTaskSessionService.abortTaskSession).toHaveBeenCalledWith("task-1");

		piTaskSessionService.cancelTaskTurn.mockResolvedValue(summary);
		const cancelResponse = await api.cancelTaskChatTurn(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);
		expect(cancelResponse.ok).toBe(true);
		expect(piTaskSessionService.cancelTaskTurn).toHaveBeenCalledWith("task-1");
	});

	it("handles clear slash commands without sending them to the model", async () => {
		const summary = createSummary({ agentId: "pi", pid: null, state: "idle" });
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.clearTaskSession.mockResolvedValue(summary);
		const broadcastTaskChatCleared = vi.fn();

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			broadcastTaskChatCleared,
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1", text: "  /clear  " },
		);

		expect(response).toEqual({
			ok: true,
			summary,
			message: null,
		});
		expect(piTaskSessionService.clearTaskSession).toHaveBeenCalledWith("__home_agent__:workspace-1");
		expect(broadcastTaskChatCleared).toHaveBeenCalledWith("workspace-1", "__home_agent__:workspace-1");
		expect(piTaskSessionService.sendTaskSessionInput).not.toHaveBeenCalled();
		expect(piTaskSessionService.startTaskSession).not.toHaveBeenCalled();
	});

	it("forwards chat images through the pi service send path", async () => {
		const summary = createSummary({ agentId: "pi", pid: null });
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.sendTaskSessionInput.mockResolvedValue(summary);
		piTaskSessionService.listMessages.mockReturnValue([]);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				text: "hello",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.sendTaskSessionInput).toHaveBeenCalledWith("task-1", "hello", undefined, [
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);
	});

	it("hydrates persisted chat messages when no live in-memory session is loaded", async () => {
		const persistedMessage = {
			id: "message-persisted-1",
			role: "assistant" as const,
			content: "Recovered from SDK artifacts",
			createdAt: Date.now(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.getSummary.mockReturnValue(null);
		piTaskSessionService.loadTaskSessionMessages.mockResolvedValue([persistedMessage]);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.getTaskChatMessages(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);

		expect(response.ok).toBe(true);
		expect(response.messages).toEqual([persistedMessage]);
		expect(piTaskSessionService.loadTaskSessionMessages).toHaveBeenCalledWith("task-1");
	});

	it("reloads a chat session through the pi task session service", async () => {
		const summary = createSummary({ agentId: "pi", pid: null });
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.reloadTaskSession.mockResolvedValue(summary);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.reloadTaskChatSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1:pi" },
		);

		expect(response).toEqual({
			ok: true,
			summary,
		});
		expect(piTaskSessionService.reloadTaskSession).toHaveBeenCalledWith("__home_agent__:workspace-1:pi");
	});

	it("restarts the home chat session from the saved launch config when reload cannot reuse cached config", async () => {
		const summary = createSummary({ agentId: "pi", pid: null });
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.reloadTaskSession.mockResolvedValue(null);
		piTaskSessionService.startTaskSession.mockResolvedValue(summary);
		setSelectedProviderSettings({
			provider: "openrouter",
			model: "openrouter/auto",
			apiKey: "sk-or-test",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: {},
		});

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.reloadTaskChatSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1:pi" },
		);

		expect(response).toEqual({
			ok: true,
			summary,
		});
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith({
			taskId: "__home_agent__:workspace-1:pi",
			cwd: "/tmp/repo",
			prompt: "",
			resumeFromPersistence: true,
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			apiKey: "sk-or-test",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoningEffort: null,
		});
	});

	it("rebinds persisted non-home chat sessions before retrying the first send after restart", async () => {
		const summary = createSummary({ agentId: "pi", pid: null });
		const latestMessage = {
			id: "message-rebound-1",
			role: "user" as const,
			content: "continue",
			createdAt: Date.now(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.sendTaskSessionInput.mockResolvedValueOnce(null).mockResolvedValueOnce(summary);
		piTaskSessionService.rebindPersistedTaskSession.mockResolvedValue(summary);
		piTaskSessionService.listMessages.mockReturnValue([latestMessage]);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", text: "continue" },
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.rebindPersistedTaskSession).toHaveBeenCalledWith("task-1");
		expect(piTaskSessionService.sendTaskSessionInput).toHaveBeenNthCalledWith(
			1,
			"task-1",
			"continue",
			undefined,
			undefined,
		);
		expect(piTaskSessionService.sendTaskSessionInput).toHaveBeenNthCalledWith(
			2,
			"task-1",
			"continue",
			undefined,
			undefined,
		);
		expect(response.message).toEqual(latestMessage);
	});

	it("auto-starts home chat sessions when the first message is sent", async () => {
		const summary = createSummary({ agentId: "pi", pid: null });
		const latestMessage = {
			id: "message-home-1",
			role: "user" as const,
			content: "hello home",
			createdAt: Date.now(),
		};
		const terminalManager = {
			writeInput: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		const runtimeConfigState = createRuntimeConfigState();
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "seed-token",
				refreshToken: "seed-refresh",
				expiresAt: Date.now() + 3_600_000,
			},
		});
		piTaskSessionService.sendTaskSessionInput.mockResolvedValue(null);
		piTaskSessionService.startTaskSession.mockResolvedValue(summary);
		piTaskSessionService.listMessages.mockReturnValue([latestMessage]);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => runtimeConfigState),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1", text: "hello home" },
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "__home_agent__:workspace-1",
				cwd: "/tmp/repo",
				prompt: "hello home",
				providerId: "anthropic",
				apiKey: null,
			}),
		);
		expect(oauthMocks.getValidKanbanCredentials).not.toHaveBeenCalled();
		expect(response.message).toEqual(latestMessage);
	});

	it("starts home chat sessions from persisted history with current launch config", async () => {
		const summary = createSummary({ agentId: "pi", pid: null });
		const latestMessage = {
			id: "message-home-rebound-1",
			role: "user" as const,
			content: "continue home",
			createdAt: Date.now(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		piTaskSessionService.sendTaskSessionInput.mockResolvedValueOnce(null);
		piTaskSessionService.startTaskSession.mockResolvedValue(summary);
		piTaskSessionService.listMessages.mockReturnValue([latestMessage]);
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "seed-token",
				refreshToken: "seed-refresh",
				expiresAt: Date.now() + 3_600_000,
			},
		});

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1", text: "continue home" },
		);

		expect(response.ok).toBe(true);
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "__home_agent__:workspace-1",
				cwd: "/tmp/repo",
				prompt: "continue home",
				resumeFromPersistence: true,
				providerId: "anthropic",
				apiKey: null,
			}),
		);
		expect(piTaskSessionService.sendTaskSessionInput).toHaveBeenCalledTimes(1);
		expect(response.message).toEqual(latestMessage);
	});

	it("home chat auto-start keeps manual API key for non-OAuth providers", async () => {
		const summary = createSummary({ agentId: "pi", pid: null });
		const terminalManager = {
			writeInput: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		const runtimeConfigState = createRuntimeConfigState();
		setSelectedProviderSettings({
			provider: "anthropic",
			apiKey: "anthropic-api-key",
			auth: {
				accessToken: "workos:seed-token",
				refreshToken: "seed-refresh",
				expiresAt: Date.now() + 3_600_000,
			},
		});
		piTaskSessionService.sendTaskSessionInput.mockResolvedValue(null);
		piTaskSessionService.startTaskSession.mockResolvedValue(summary);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => runtimeConfigState),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1", text: "hello home" },
		);

		expect(response.ok).toBe(true);
		expect(oauthMocks.getValidKanbanCredentials).not.toHaveBeenCalled();
		expect(piTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				apiKey: "anthropic-api-key",
			}),
		);
	});

	it("returns cline provider catalog and provider models", async () => {
		const terminalManager = {
			writeInput: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				return createRuntimeConfigState();
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			model: "claude-sonnet-4-6",
		});

		const catalogResponse = await api.getKanbanProviderCatalog({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});
		expect(catalogResponse.providers.some((provider) => provider.id === "cline")).toBe(true);
		expect(catalogResponse.providers.find((provider) => provider.id === "cline")?.enabled).toBe(true);

		const modelsResponse = await api.getKanbanProviderModels(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ providerId: "cline" },
		);
		expect(modelsResponse.providerId).toBe("cline");
		expect(modelsResponse.models.some((model) => model.id === "claude-sonnet-4-6")).toBe(true);
	});

	it("loads provider models from the bundled model registry", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "anthropic-key",
		});

		const response = await api.getKanbanProviderModels(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ providerId: "anthropic" },
		);

		// The omp runtime resolves models from the bundled `models.json` registry.
		expect(response.providerId).toBe("anthropic");
		expect(response.models.length).toBeGreaterThan(0);
		for (const model of response.models) {
			expect(model.id.length).toBeGreaterThan(0);
			expect(model.name.length).toBeGreaterThan(0);
		}
		const names = response.models.map((model) => model.name);
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
	});

	it("discovers provider models from the configured /models endpoint", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		// A custom (non-bundled) provider with a base URL discovers models from
		// the OpenAI-compatible `/models` endpoint.
		setSelectedProviderSettings({
			provider: "my-proxy",
			model: "proxy-default",
			apiKey: "proxy-key",
			baseUrl: "http://localhost:4010/v1",
		});
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				data: [
					{ id: "proxy-model-b", name: "Proxy Model B" },
					{ id: "proxy-model-a", name: "Proxy Model A" },
				],
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);

		try {
			const response = await api.getKanbanProviderModels(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ providerId: "my-proxy" },
			);

			expect(fetchMock).toHaveBeenCalledWith(
				"http://localhost:4010/v1/models",
				expect.objectContaining({ method: "GET" }),
			);
			expect(response.providerId).toBe("my-proxy");
			expect(response.models).toEqual([
				{ id: "proxy-model-a", name: "Proxy Model A" },
				{ id: "proxy-model-b", name: "Proxy Model B" },
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("prefers the bundled registry over endpoint discovery", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		// `deepseek` is a bundled provider, so even with a base URL configured the
		// runtime serves bundled models and never calls the `/models` endpoint.
		setSelectedProviderSettings({
			provider: "deepseek",
			model: "deepseek-v4-flash",
			apiKey: "deepseek-key",
			baseUrl: "http://localhost:9999/v1",
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		try {
			const response = await api.getKanbanProviderModels(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ providerId: "deepseek" },
			);

			expect(response.providerId).toBe("deepseek");
			expect(response.models.some((model) => model.id === "deepseek-v4-flash")).toBe(true);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("falls back to the queried provider's saved model when provider model loading fails", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		// A custom (non-bundled) provider with no base URL cannot list models, so
		// the runtime falls back to the provider's saved model id.
		oauthMocks.getLastUsedProviderSettings.mockReturnValue({
			provider: "my-fallback",
			model: "my-fallback/v1",
			apiKey: "fallback-key",
		});
		oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
			providerId === "my-fallback"
				? {
						provider: "my-fallback",
						model: "my-fallback/v1",
						apiKey: "fallback-key",
					}
				: null,
		);

		const response = await api.getKanbanProviderModels(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ providerId: "my-fallback" },
		);

		expect(response).toEqual({
			providerId: "my-fallback",
			models: [
				{
					id: "my-fallback/v1",
					name: "my-fallback/v1",
				},
			],
		});
	});

	it("adds a custom OpenAI-compatible provider through the SDK-backed flow", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		// No provider exists yet; after the save the omp store returns the new one.
		oauthMocks.getAllProviders.mockReturnValue({});
		oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
			providerId === "my-provider"
				? {
						provider: "my-provider",
						model: "qwen2.5-coder:32b",
						apiKey: "secret-key",
						baseUrl: "http://localhost:8000/v1",
					}
				: null,
		);

		const response = await api.addKanbanProvider(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				providerId: "my-provider",
				name: "My Provider",
				baseUrl: "http://localhost:8000/v1",
				apiKey: "secret-key",
				models: ["qwen2.5-coder:32b"],
				defaultModelId: "qwen2.5-coder:32b",
				capabilities: ["tools", "streaming"],
			},
		);

		expect(response).toEqual(
			expect.objectContaining({
				providerId: "my-provider",
				modelId: "qwen2.5-coder:32b",
				baseUrl: "http://localhost:8000/v1",
				apiKeyConfigured: true,
			}),
		);
		// The omp runtime persists the custom provider through the local provider
		// settings store (one `SaveProviderSettingsInput` argument).
		expect(oauthMocks.saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				settings: expect.objectContaining({
					provider: "my-provider",
					model: "qwen2.5-coder:32b",
					apiKey: "secret-key",
					baseUrl: "http://localhost:8000/v1",
				}),
				tokenSource: "manual",
				setLastUsed: true,
			}),
		);
	});

	it("returns a null account profile in the omp runtime", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		const response = await api.getKanbanAccountProfile({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		// The omp runtime has no Kanban account backend; profile is always null and
		// no remote account service is constructed or queried.
		expect(response.profile).toBeNull();
		expect(kanbanAccountMocks.constructedOptions).toHaveLength(0);
		expect(kanbanAccountMocks.fetchMe).not.toHaveBeenCalled();
	});

	it("returns a null account profile even when OAuth credentials are present", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:expired-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		const response = await api.getKanbanAccountProfile({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.profile).toBeNull();
		// No OAuth credential refresh is attempted in the omp runtime.
		expect(oauthMocks.getValidKanbanCredentials).not.toHaveBeenCalled();
		expect(kanbanAccountMocks.fetchMe).not.toHaveBeenCalled();
	});

	it("keeps kanban access enabled and ignores remote config in the omp runtime", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});
		// Even a remote config that would disable kanban is irrelevant: the omp
		// runtime never consults the remote account service.
		kanbanAccountMocks.fetchRemoteConfig.mockResolvedValueOnce({
			organizationId: "org-1",
			enabled: true,
			value: JSON.stringify({
				kanbanEnabled: false,
			}),
		});

		const response = await api.getKanbanKanbanAccess({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.enabled).toBe(true);
		expect(kanbanAccountMocks.fetchRemoteConfig).not.toHaveBeenCalled();
	});

	it("keeps kanban access enabled regardless of remote config availability", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});
		kanbanAccountMocks.fetchRemoteConfig.mockRejectedValue(new Error("remote config request failed"));

		const initialResponse = await api.getKanbanKanbanAccess({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});
		const secondResponse = await api.getKanbanKanbanAccess({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(initialResponse.enabled).toBe(true);
		expect(secondResponse.enabled).toBe(true);
		expect(kanbanAccountMocks.fetchRemoteConfig).not.toHaveBeenCalled();
	});

	it("allows kanban by default for non-cline providers", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "anthropic",
			apiKey: "anthropic-api-key",
		});

		const response = await api.getKanbanKanbanAccess({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.enabled).toBe(true);
		expect(kanbanAccountMocks.fetchRemoteConfig).not.toHaveBeenCalled();
	});

	it("reports that provider OAuth login is not supported in the omp runtime", async () => {
		const terminalManager = {
			writeInput: vi.fn(),
		};
		const piTaskSessionService = createPiTaskSessionServiceMock();
		const bumpKanbanSessionContextVersion = vi.fn();

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			bumpKanbanSessionContextVersion,
		});

		const response = await api.runKanbanProviderOAuthLogin(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ provider: "cline" },
		);

		// The omp runtime does not manage provider OAuth; it reports failure
		// without touching the SDK login flow or persisting settings.
		expect(response.ok).toBe(false);
		expect(response.provider).toBe("cline");
		expect(response.error).toMatch(/not supported in the omp runtime/i);
		expect(oauthMocks.loginKanbanOAuth).not.toHaveBeenCalled();
		expect(oauthMocks.saveProviderSettings).not.toHaveBeenCalled();
		expect(bumpKanbanSessionContextVersion).not.toHaveBeenCalled();
	});

	it("bumps cline session context when provider settings are saved", async () => {
		const bumpKanbanSessionContextVersion = vi.fn();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			bumpKanbanSessionContextVersion,
		});
		setSelectedProviderSettings({
			provider: "openrouter",
			model: "openrouter/auto",
			apiKey: "openrouter-key",
			baseUrl: "https://openrouter.ai/api/v1",
		});

		const response = await api.saveKanbanProviderSettings(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				providerId: "openrouter",
				modelId: "openrouter/free",
			},
		);

		expect(response.providerId).toBe("openrouter");
		expect(bumpKanbanSessionContextVersion).toHaveBeenCalledTimes(1);
	});

	it("returns Kanban MCP settings", async () => {
		writeFileSync(
			mcpSettingsPath,
			JSON.stringify(
				{
					mcpServers: {
						linear: {
							type: "streamableHttp",
							url: "https://mcp.linear.app/mcp",
							disabled: false,
						},
					},
				},
				null,
				2,
			),
		);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.getKanbanMcpSettings({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.path).toBe(mcpSettingsPath);
		expect(response.servers).toEqual([
			{
				name: "linear",
				disabled: false,
				type: "streamableHttp",
				url: "https://mcp.linear.app/mcp",
			},
		]);
	});

	it("saves Kanban MCP settings", async () => {
		const bumpKanbanSessionContextVersion = vi.fn();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			bumpKanbanSessionContextVersion,
		});

		const response = await api.saveKanbanMcpSettings(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				servers: [
					{
						name: "linear",
						disabled: false,
						type: "streamableHttp",
						url: "https://mcp.linear.app/mcp",
					},
				],
			},
		);

		expect(response.path).toBe(mcpSettingsPath);
		expect(response.servers).toEqual([
			{
				name: "linear",
				disabled: false,
				type: "streamableHttp",
				url: "https://mcp.linear.app/mcp",
			},
		]);
		expect(bumpKanbanSessionContextVersion).toHaveBeenCalledTimes(1);
	});

	it("returns MCP auth statuses from persisted OAuth settings", async () => {
		writeFileSync(
			mcpSettingsPath,
			JSON.stringify(
				{
					mcpServers: {
						linear: {
							type: "streamableHttp",
							url: "https://mcp.linear.app/mcp",
						},
						filesystem: {
							type: "stdio",
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
						},
					},
				},
				null,
				2,
			),
		);
		writeFileSync(
			mcpOauthSettingsPath,
			JSON.stringify(
				{
					servers: {
						linear: {
							tokens: {
								access_token: "token-1",
								token_type: "Bearer",
							},
							lastAuthenticatedAt: 1_700_000_000_000,
						},
					},
				},
				null,
				2,
			),
		);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.getKanbanMcpAuthStatuses({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.statuses).toEqual([
			{
				serverName: "filesystem",
				oauthSupported: false,
				oauthConfigured: false,
				lastError: null,
				lastAuthenticatedAt: null,
			},
			{
				serverName: "linear",
				oauthSupported: true,
				oauthConfigured: true,
				lastError: null,
				lastAuthenticatedAt: 1_700_000_000_000,
			},
		]);
	});

	it("rejects MCP OAuth flow for stdio servers", async () => {
		writeFileSync(
			mcpSettingsPath,
			JSON.stringify(
				{
					mcpServers: {
						filesystem: {
							type: "stdio",
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
						},
					},
				},
				null,
				2,
			),
		);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		await expect(
			api.runKanbanMcpServerOAuth(
				{
					workspaceId: "workspace-1",
					workspacePath: "/tmp/repo",
				},
				{
					serverName: "filesystem",
				},
			),
		).rejects.toThrow("does not support OAuth browser flow");
	});

	it("runs reset teardown before deleting debug state paths", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [
			join(tempHome, ".kanban", "data"),
			join(tempHome, ".kanban", "projects"),
			join(tempHome, ".kanban", "worktrees"),
		];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const prepareForStateReset = vi.fn(async () => {
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		});
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			prepareForStateReset,
		});

		try {
			const response = await api.resetAllState(null);

			expect(response.ok).toBe(true);
			expect(prepareForStateReset).toHaveBeenCalledTimes(1);
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(false);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("aborts reset path deletion when teardown fails", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [
			join(tempHome, ".kanban", "data"),
			join(tempHome, ".kanban", "projects"),
			join(tempHome, ".kanban", "worktrees"),
		];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			prepareForStateReset: vi.fn(async () => {
				throw new Error("teardown failed");
			}),
		});

		try {
			await expect(api.resetAllState(null)).rejects.toThrow("teardown failed");
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});

describe("createRuntimeApi getFeaturebaseToken", () => {
	beforeEach(() => {
		oauthMocks.getProviderSettings.mockReset();
		oauthMocks.getLastUsedProviderSettings.mockReset();
		oauthMocks.getValidKanbanCredentials.mockReset();
		oauthMocks.saveProviderSettings.mockReset();
		kanbanAccountMocks.fetchFeaturebaseToken.mockReset();
		kanbanAccountMocks.constructedOptions.length = 0;
	});

	const NOT_SUPPORTED = "Featurebase token is not supported in the omp runtime.";

	it("throws because featurebase is not supported in the omp runtime", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		await expect(
			api.getFeaturebaseToken({
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			}),
		).rejects.toThrow(NOT_SUPPORTED);
		// The omp runtime never reaches the SDK featurebase call.
		expect(kanbanAccountMocks.fetchFeaturebaseToken).not.toHaveBeenCalled();
	});

	it("throws not-supported even when no provider settings are configured", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings(null);

		await expect(
			api.getFeaturebaseToken({
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			}),
		).rejects.toThrow(NOT_SUPPORTED);
	});

	it("throws not-supported regardless of the selected provider", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "oca",
			auth: {
				accessToken: "some-token",
				refreshToken: "some-refresh",
			},
		});

		await expect(
			api.getFeaturebaseToken({
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			}),
		).rejects.toThrow(NOT_SUPPORTED);
	});

	it("throws not-supported without attempting any OAuth refresh", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:stale-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		await expect(
			api.getFeaturebaseToken({
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			}),
		).rejects.toThrow(NOT_SUPPORTED);
		expect(kanbanAccountMocks.fetchFeaturebaseToken).not.toHaveBeenCalled();
		expect(oauthMocks.getValidKanbanCredentials).not.toHaveBeenCalled();
	});
});

describe("createRuntimeApi update handlers", () => {
	it("delegates update status to the required dependency", async () => {
		const getUpdateStatus = vi.fn(() => ({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			updateAvailable: true,
			updateTiming: "startup" as const,
			installCommand: "npm install -g kanban@latest",
		}));
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			getUpdateStatus,
		});

		await expect(api.getUpdateStatus(null)).resolves.toEqual({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			updateAvailable: true,
			updateTiming: "startup",
			installCommand: "npm install -g kanban@latest",
		});
		expect(getUpdateStatus).toHaveBeenCalledTimes(1);
	});

	it("delegates update execution to the required dependency", async () => {
		const runUpdateNow = vi.fn(async () => ({
			status: "updated" as const,
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			message: "Updated Kanban to 0.2.0.",
		}));
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedPiTaskSessionService: vi.fn(async () => createPiTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			runUpdateNow,
		});

		await expect(api.runUpdateNow(null)).resolves.toEqual({
			status: "updated",
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			message: "Updated Kanban to 0.2.0.",
		});
		expect(runUpdateNow).toHaveBeenCalledTimes(1);
	});
});
