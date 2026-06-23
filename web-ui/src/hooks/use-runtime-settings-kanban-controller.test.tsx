import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRuntimeSettingsKanbanController } from "@/hooks/use-runtime-settings-kanban-controller";
import type {
	RuntimeKanbanProviderModel,
	RuntimeReasoningEffort,
	RuntimeConfigResponse,
	RuntimeTaskAgentSettings,
} from "@/runtime/types";

const fetchKanbanProviderCatalogMock = vi.hoisted(() => vi.fn());
const fetchKanbanProviderModelsMock = vi.hoisted(() => vi.fn());
const saveAgentProviderConfigMock = vi.hoisted(() => vi.fn());
const fetchAgentProviderSetsMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/runtime-config-query", () => ({
	saveAgentProviderConfig: saveAgentProviderConfigMock,
	fetchAgentProviderSets: fetchAgentProviderSetsMock,
	fetchKanbanProviderCatalog: fetchKanbanProviderCatalogMock,
	fetchKanbanProviderModels: fetchKanbanProviderModelsMock,
}));

interface HookSnapshot {
	providerId: string;
	modelId: string;
	apiKey: string;
	baseUrl: string;
	reasoningEffort: string;
	providerCatalogIds: string[];
	providerModelIds: string[];
	selectedModelSupportsReasoningEffort: boolean;
	apiKeyConfigured: boolean;
	hasUnsavedChanges: boolean;
	setProviderId: (value: string) => void;
	setModelId: (value: string) => void;
	setApiKey: (value: string) => void;
	setBaseUrl: (value: string) => void;
	setReasoningEffort: (value: string) => void;
	saveProviderSettings: (
		overrides?: Parameters<ReturnType<typeof useRuntimeSettingsKanbanController>["saveProviderSettings"]>[0],
	) => Promise<{ ok: boolean; message?: string }>;
	refreshProviderModels: () => Promise<{ ok: boolean; message?: string }>;
	addCustomProvider: (
		input: Parameters<ReturnType<typeof useRuntimeSettingsKanbanController>["addCustomProvider"]>[0],
	) => Promise<{ ok: boolean; message?: string }>;
	updateCustomProvider: (
		input: Parameters<ReturnType<typeof useRuntimeSettingsKanbanController>["updateCustomProvider"]>[0],
	) => Promise<{ ok: boolean; message?: string }>;
}

function createRuntimeConfigResponse(
	providerOverrides: Partial<RuntimeConfigResponse["kanbanProviderSettings"]> = {},
): RuntimeConfigResponse {
	return {
		selectedAgentId: "pi",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: "pi",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project/.kanban/kanban/config.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: ["pi"],
		agents: [
			{
				id: "pi",
				label: "Pi",
				binary: "pi",
				command: "pi",
				defaultArgs: [],
				installed: true,
				configured: true,
			},
		],
		shortcuts: [],
		kanbanProviderSettings: {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			baseUrl: null,
			reasoningEffort: null,
			apiKeyConfigured: true,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
			...providerOverrides,
		},
		commitPromptTemplate: "",
		openPrPromptTemplate: "",
		commitPromptTemplateDefault: "",
		openPrPromptTemplateDefault: "",
		proxyEnabled: false,
		proxyHost: "",
		proxyPort: "",
		proxyUsername: "",
		proxyPassword: "",
		noProxy: "",
	};
}

function createLegacyRuntimeConfigResponse(): RuntimeConfigResponse {
	const { kanbanProviderSettings: _kanbanProviderSettings, ...legacyConfig } = createRuntimeConfigResponse();
	return legacyConfig as RuntimeConfigResponse;
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected hook snapshot.");
	}
	return snapshot;
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve: (value: T) => void = () => {};
	let reject: (reason?: unknown) => void = () => {};
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function HookHarness({
	open,
	workspaceId,
	config,
	taskKanbanSettings,
	onSnapshot,
}: {
	open: boolean;
	workspaceId: string | null;
	config: RuntimeConfigResponse | null;
	taskKanbanSettings?: RuntimeTaskAgentSettings;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const state = useRuntimeSettingsKanbanController({
		open,
		workspaceId,
		config,
		taskKanbanSettings,
	});

	useEffect(() => {
		onSnapshot({
			providerId: state.providerId,
			modelId: state.modelId,
			apiKey: state.apiKey,
			baseUrl: state.baseUrl,
			reasoningEffort: state.reasoningEffort,
			providerCatalogIds: state.providerCatalog.map((provider) => provider.id),
			providerModelIds: state.providerModels.map((model) => model.id),
			selectedModelSupportsReasoningEffort: state.selectedModelSupportsReasoningEffort,
			apiKeyConfigured: state.apiKeyConfigured,
			hasUnsavedChanges: state.hasUnsavedChanges,
			setProviderId: (value) => {
				state.setProviderId(value);
			},
			setModelId: (value) => {
				state.setModelId(value);
			},
			setApiKey: (value) => {
				state.setApiKey(value);
			},
			setBaseUrl: (value) => {
				state.setBaseUrl(value);
			},
			setReasoningEffort: (value) => {
				state.setReasoningEffort(value as RuntimeReasoningEffort | "");
			},
			saveProviderSettings: state.saveProviderSettings,
			refreshProviderModels: state.refreshProviderModels,
			addCustomProvider: state.addCustomProvider,
			updateCustomProvider: state.updateCustomProvider,
		});
	}, [onSnapshot, state]);

	return null;
}

describe("useRuntimeSettingsKanbanController", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		fetchKanbanProviderCatalogMock.mockReset();
		fetchKanbanProviderModelsMock.mockReset();
		saveAgentProviderConfigMock.mockReset();
		fetchAgentProviderSetsMock.mockReset();
		fetchAgentProviderSetsMock.mockResolvedValue({ agents: {} });
		fetchKanbanProviderCatalogMock.mockResolvedValue([]);
		fetchKanbanProviderModelsMock.mockResolvedValue([]);
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("loads provider catalog and models for the current Kanban provider", async () => {
		const config = createRuntimeConfigResponse();
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "anthropic",
				name: "Anthropic",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "claude-sonnet-4-6",
				baseUrl: "https://api.anthropic.com",
			},
		]);
		fetchKanbanProviderModelsMock.mockResolvedValue([
			{
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6",
				supportsReasoningEffort: false,
			},
		]);

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		expect(fetchKanbanProviderCatalogMock).toHaveBeenCalledWith("workspace-1");
		expect(fetchKanbanProviderModelsMock).toHaveBeenCalledWith("workspace-1", "anthropic");
		expect(requireSnapshot(latestSnapshot).providerCatalogIds).toEqual(["anthropic"]);
		expect(requireSnapshot(latestSnapshot).providerModelIds).toEqual(["claude-sonnet-4-6"]);
		expect(requireSnapshot(latestSnapshot).selectedModelSupportsReasoningEffort).toBe(false);
		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(false);
	});

	it("loads provider catalog and models without a selected workspace", async () => {
		const config = createRuntimeConfigResponse();
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "anthropic",
				name: "Anthropic",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "claude-sonnet-4-6",
				baseUrl: "https://api.anthropic.com",
			},
		]);
		fetchKanbanProviderModelsMock.mockResolvedValue([
			{
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6",
				supportsReasoningEffort: false,
			},
		]);

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId={null}
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		expect(fetchKanbanProviderCatalogMock).toHaveBeenCalledWith(null);
		expect(fetchKanbanProviderModelsMock).toHaveBeenCalledWith(null, "anthropic");
		expect(requireSnapshot(latestSnapshot).providerCatalogIds).toEqual(["anthropic"]);
		expect(requireSnapshot(latestSnapshot).providerModelIds).toEqual(["claude-sonnet-4-6"]);
	});

	it("defaults provider settings to the configured provider when the config omits provider settings", async () => {
		const config = createLegacyRuntimeConfigResponse();
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "anthropic",
				name: "Anthropic",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "claude-sonnet-4-6",
				baseUrl: "https://api.anthropic.com",
			},
		]);

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		expect(fetchKanbanProviderCatalogMock).toHaveBeenCalledWith("workspace-1");
		expect(requireSnapshot(latestSnapshot).modelId).toBe("claude-sonnet-4-6");
		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(true);
	});

	it("defaults the model when Kanban settings load with a blank model", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "anthropic",
			oauthProvider: null,
			modelId: null,
		});
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "anthropic",
				name: "Anthropic",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "claude-sonnet-4-6",
				baseUrl: "https://api.anthropic.com",
			},
		]);

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).providerId).toBe("anthropic");
		expect(requireSnapshot(latestSnapshot).modelId).toBe("claude-sonnet-4-6");
	});

	it("fills the provider base url from the catalog when the saved settings are blank", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "openrouter",
			oauthProvider: null,
			modelId: "gpt-5",
			baseUrl: null,
		});
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "openrouter",
				name: "OpenRouter",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "gpt-5",
				baseUrl: "https://openrouter.ai/api/v1",
			},
		]);

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).providerId).toBe("openrouter");
		expect(requireSnapshot(latestSnapshot).baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(false);
	});

	it("treats task-level provider, model, and reasoning overrides as the clean baseline", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "openrouter",
			modelId: "openai/gpt-5",
			reasoningEffort: "high",
		});
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "openrouter",
				name: "OpenRouter",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "openai/gpt-5",
				baseUrl: "https://openrouter.ai/api/v1",
			},
		]);
		fetchKanbanProviderModelsMock.mockResolvedValue([
			{
				id: "anthropic/claude-sonnet-4.6",
				name: "Claude Sonnet 4.6",
				contextWindow: null,
				maxOutputTokens: null,
				supportsReasoningEffort: true,
			},
		]);

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					taskKanbanSettings={{
						providerId: "openrouter",
						modelId: "anthropic/claude-sonnet-4.6",
						reasoningEffort: "low",
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).providerId).toBe("openrouter");
		expect(requireSnapshot(latestSnapshot).modelId).toBe("anthropic/claude-sonnet-4.6");
		expect(requireSnapshot(latestSnapshot).reasoningEffort).toBe("low");
		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(false);
	});

	it("treats task-level provider or model overrides with no reasoning override as model default", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "openrouter",
			modelId: "openai/gpt-5",
			reasoningEffort: "high",
		});
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "openrouter",
				name: "OpenRouter",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "openai/gpt-5",
				baseUrl: "https://openrouter.ai/api/v1",
			},
		]);
		fetchKanbanProviderModelsMock.mockResolvedValue([
			{
				id: "anthropic/claude-sonnet-4.6",
				name: "Claude Sonnet 4.6",
				contextWindow: null,
				maxOutputTokens: null,
				supportsReasoningEffort: true,
			},
		]);

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					taskKanbanSettings={{
						modelId: "anthropic/claude-sonnet-4.6",
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).modelId).toBe("anthropic/claude-sonnet-4.6");
		expect(requireSnapshot(latestSnapshot).reasoningEffort).toBe("");
		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(false);
	});

	it("treats an explicit task-level default reasoning override as the clean baseline", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "openrouter",
			modelId: "openai/gpt-5",
			reasoningEffort: "high",
		});
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "openrouter",
				name: "OpenRouter",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "openai/gpt-5",
				baseUrl: "https://openrouter.ai/api/v1",
			},
		]);
		fetchKanbanProviderModelsMock.mockResolvedValue([
			{
				id: "openai/gpt-5",
				name: "GPT-5",
				contextWindow: null,
				maxOutputTokens: null,
				supportsReasoningEffort: true,
			},
		]);

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					taskKanbanSettings={{}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).reasoningEffort).toBe("");
		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(false);
	});

	it("saves the current provider draft and clears dirty state using the saved override", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "anthropic",
			oauthProvider: null,
			modelId: "claude-sonnet-4-5",
			baseUrl: "https://old.example.com",
		});
		let latestSnapshot: HookSnapshot | null = null;
		saveAgentProviderConfigMock.mockResolvedValue({
			ok: true,
			config: {
				agentId: "pi",
				provider: "openrouter",
				model: "gpt-5",
				baseUrl: "https://openrouter.ai/api",
				apiKey: "secret-key",
				reasoning: { effort: "high" },
			},
		});

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setProviderId("openrouter");
			requireSnapshot(latestSnapshot).setModelId("gpt-5");
			requireSnapshot(latestSnapshot).setBaseUrl("https://openrouter.ai/api");
			requireSnapshot(latestSnapshot).setApiKey("secret-key");
			requireSnapshot(latestSnapshot).setReasoningEffort("high");
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(true);

		await act(async () => {
			expect(await requireSnapshot(latestSnapshot).saveProviderSettings()).toEqual({ ok: true });
		});

		expect(saveAgentProviderConfigMock).toHaveBeenCalledWith("workspace-1", "pi", {
			agentId: "pi",
			provider: "openrouter",
			model: "gpt-5",
			apiKey: "secret-key",
			baseUrl: "https://openrouter.ai/api",
			reasoning: { effort: "high" },
		});
		expect(requireSnapshot(latestSnapshot).providerId).toBe("openrouter");
		expect(requireSnapshot(latestSnapshot).modelId).toBe("gpt-5");
		expect(requireSnapshot(latestSnapshot).baseUrl).toBe("https://openrouter.ai/api");
		expect(requireSnapshot(latestSnapshot).reasoningEffort).toBe("high");
		expect(requireSnapshot(latestSnapshot).apiKey).toBe("");
		expect(requireSnapshot(latestSnapshot).apiKeyConfigured).toBe(true);
		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(false);
	});

	it("does not clear a saved manual api key when saving model-only overrides", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "openrouter",
			oauthProvider: null,
			modelId: "openrouter/auto",
			baseUrl: "https://openrouter.ai/api/v1",
			apiKeyConfigured: true,
		});
		let latestSnapshot: HookSnapshot | null = null;
		saveAgentProviderConfigMock.mockResolvedValue({
			ok: true,
			config: {
				agentId: "pi",
				provider: "openrouter",
				model: "openrouter/free",
				baseUrl: "https://openrouter.ai/api/v1",
			},
		});

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			expect(await requireSnapshot(latestSnapshot).saveProviderSettings({ modelId: "openrouter/free" })).toEqual({
				ok: true,
			});
		});

		expect(saveAgentProviderConfigMock).toHaveBeenCalledWith("workspace-1", "pi", {
			agentId: "pi",
			provider: "openrouter",
			model: "openrouter/free",
			baseUrl: "https://openrouter.ai/api/v1",
		});
	});

	it("saves base URL provider settings before refreshing models", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "litellm",
			oauthProvider: null,
			modelId: "gpt-5.4",
			baseUrl: null,
			apiKeyConfigured: false,
		});
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "litellm",
				name: "LiteLLM",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "gpt-5.4",
				baseUrl: "http://localhost:4000/v1",
				supportsBaseUrl: true,
			},
		]);
		fetchKanbanProviderModelsMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{
				id: "private-proxy-model",
				name: "private-proxy-model",
				supportsReasoningEffort: true,
			},
		]);
		saveAgentProviderConfigMock.mockResolvedValue({
			ok: true,
			config: {
				agentId: "pi",
				provider: "litellm",
				model: "gpt-5.4",
				baseUrl: "http://127.0.0.1:4010/v1",
				apiKey: "test-key-catalog",
			},
		});

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).baseUrl).toBe("http://localhost:4000/v1");
		expect(requireSnapshot(latestSnapshot).providerModelIds).toEqual([]);

		await act(async () => {
			requireSnapshot(latestSnapshot).setBaseUrl("http://127.0.0.1:4010/v1");
			requireSnapshot(latestSnapshot).setApiKey("test-key-catalog");
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(true);

		await act(async () => {
			expect(await requireSnapshot(latestSnapshot).refreshProviderModels()).toEqual({ ok: true });
			await flushAsyncWork();
		});

		expect(saveAgentProviderConfigMock).toHaveBeenCalledWith("workspace-1", "pi", {
			agentId: "pi",
			provider: "litellm",
			model: "gpt-5.4",
			apiKey: "test-key-catalog",
			baseUrl: "http://127.0.0.1:4010/v1",
		});
		expect(fetchKanbanProviderModelsMock).toHaveBeenLastCalledWith("workspace-1", "litellm");
		expect(requireSnapshot(latestSnapshot).providerModelIds).toEqual(["private-proxy-model"]);
		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(false);
	});

	it("keeps refreshed provider models when the initial model load resolves later", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "litellm",
			oauthProvider: null,
			modelId: "gpt-5.4",
			baseUrl: "http://localhost:4000/v1",
			apiKeyConfigured: false,
		});
		const initialModels = createDeferred<RuntimeKanbanProviderModel[]>();
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "litellm",
				name: "LiteLLM",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "gpt-5.4",
				baseUrl: "http://localhost:4000/v1",
				supportsBaseUrl: true,
			},
		]);
		fetchKanbanProviderModelsMock.mockReturnValueOnce(initialModels.promise).mockResolvedValueOnce([
			{
				id: "fresh-proxy-model",
				name: "fresh-proxy-model",
			},
		]);
		saveAgentProviderConfigMock.mockResolvedValue({
			ok: true,
			config: {
				agentId: "pi",
				provider: "litellm",
				model: "gpt-5.4",
				baseUrl: "http://127.0.0.1:4010/v1",
			},
		});

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setBaseUrl("http://127.0.0.1:4010/v1");
			await flushAsyncWork();
		});

		await act(async () => {
			expect(await requireSnapshot(latestSnapshot).refreshProviderModels()).toEqual({ ok: true });
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).providerModelIds).toEqual(["fresh-proxy-model"]);

		await act(async () => {
			initialModels.resolve([
				{
					id: "stale-proxy-model",
					name: "stale-proxy-model",
				},
			]);
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).providerModelIds).toEqual(["fresh-proxy-model"]);
	});

	it("adds a custom provider and refreshes models", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "anthropic",
			oauthProvider: null,
			modelId: "claude-sonnet-4-6",
		});
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "anthropic",
				name: "Anthropic",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "claude-sonnet-4-6",
			},
		]);
		fetchKanbanProviderModelsMock
			.mockResolvedValueOnce([
				{
					id: "claude-sonnet-4-6",
					name: "Claude Sonnet 4.6",
				},
			])
			.mockResolvedValue([
				{
					id: "qwen2.5-coder:32b",
					name: "Qwen 2.5 Coder 32B",
				},
			]);
		saveAgentProviderConfigMock.mockResolvedValue({
			ok: true,
			config: {
				agentId: "pi",
				provider: "my-provider",
				model: "qwen2.5-coder:32b",
				baseUrl: "http://localhost:8000/v1",
				apiKey: "secret-key",
			},
		});

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		await act(async () => {
			expect(
				await requireSnapshot(latestSnapshot).addCustomProvider({
					providerId: "my-provider",
					name: "My Provider",
					baseUrl: "http://localhost:8000/v1",
					apiKey: "secret-key",
					models: ["qwen2.5-coder:32b"],
					defaultModelId: "qwen2.5-coder:32b",
					modelsSourceUrl: null,
				}),
			).toEqual({ ok: true });
		});

		// The endpoint is written only on `protocols[]` (single source of truth); a
		// legacy scalar `baseUrl` input folds into it and is never written top-level.
		expect(saveAgentProviderConfigMock).toHaveBeenCalledWith("workspace-1", "pi", expect.objectContaining({
			agentId: "pi",
			provider: "my-provider",
			protocols: [{ protocol: "openai", baseUrl: "http://localhost:8000/v1" }],
			apiKey: "secret-key",
			model: "qwen2.5-coder:32b",
			// The full model list must be persisted, not just the default (fdd77).
			models: ["qwen2.5-coder:32b"],
		}));
		const savedConfig = saveAgentProviderConfigMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
		expect(savedConfig).not.toHaveProperty("baseUrl");
		expect(fetchKanbanProviderCatalogMock).toHaveBeenLastCalledWith("workspace-1");
		expect(fetchKanbanProviderModelsMock).toHaveBeenLastCalledWith("workspace-1", "my-provider");
		expect(requireSnapshot(latestSnapshot).providerId).toBe("my-provider");
		expect(requireSnapshot(latestSnapshot).modelId).toBe("qwen2.5-coder:32b");
		expect(requireSnapshot(latestSnapshot).baseUrl).toBe("http://localhost:8000/v1");
		expect(requireSnapshot(latestSnapshot).apiKeyConfigured).toBe(true);
		expect(requireSnapshot(latestSnapshot).providerCatalogIds).toEqual(["anthropic"]);
		expect(requireSnapshot(latestSnapshot).providerModelIds).toEqual(["qwen2.5-coder:32b"]);
		expect(requireSnapshot(latestSnapshot).hasUnsavedChanges).toBe(false);
	});

	it("edits a non-default provider against its own config, not the agent default", async () => {
		const config = createRuntimeConfigResponse({ providerId: "anthropic" });
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([]);
		fetchKanbanProviderModelsMock.mockResolvedValue([]);
		// The agent has two providers: the default "anthropic" (A) and a non-default
		// "my-relay" (B). Both are secret-free (apiKey redacted out of the set view).
		fetchAgentProviderSetsMock.mockResolvedValue({
			agents: {
				pi: {
					agentId: "pi",
					defaultProviderId: "anthropic",
					providers: [
						{
							agentId: "pi",
							provider: "anthropic",
							model: "a-model",
							models: ["a-model"],
							protocols: [{ protocol: "anthropic", baseUrl: "https://api.anthropic.com" }],
						},
						{
							agentId: "pi",
							provider: "my-relay",
							model: "relay-1",
							models: ["relay-1", "relay-2"],
							protocols: [{ protocol: "openai", baseUrl: "https://relay.local" }],
						},
					],
				},
			},
		});
		saveAgentProviderConfigMock.mockResolvedValue({
			ok: true,
			config: { agentId: "pi", provider: "my-relay", model: "relay-2" },
		});

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});
		await act(async () => {
			await flushAsyncWork();
		});

		// Edit only the default model of the non-default provider. Every untouched
		// field must come from "my-relay" (B), never the agent default "anthropic" (A).
		await act(async () => {
			expect(
				await requireSnapshot(latestSnapshot).updateCustomProvider({
					providerId: "my-relay",
					defaultModelId: "relay-2",
				}),
			).toEqual({ ok: true });
		});

		const savedConfig = saveAgentProviderConfigMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
		expect(savedConfig.provider).toBe("my-relay");
		// The changed field is applied...
		expect(savedConfig.model).toBe("relay-2");
		// ...and untouched fields come from B, not the default A.
		expect(savedConfig.protocols).toEqual([{ protocol: "openai", baseUrl: "https://relay.local" }]);
		expect(savedConfig.models).toEqual(["relay-1", "relay-2"]);
		// No apiKey is sent (the user did not re-enter one); the server preserves it.
		expect(savedConfig).not.toHaveProperty("apiKey");
		// The derived legacy scalar baseUrl is never written top-level.
		expect(savedConfig).not.toHaveProperty("baseUrl");
	});

	it("shows reasoning effort support for GPT style models", async () => {
		const config = createRuntimeConfigResponse({
			providerId: "openrouter",
			oauthProvider: null,
			modelId: "openai/gpt-5.4",
		});
		let latestSnapshot: HookSnapshot | null = null;
		fetchKanbanProviderCatalogMock.mockResolvedValue([
			{
				id: "openrouter",
				name: "OpenRouter",
				oauthSupported: false,
				enabled: true,
				defaultModelId: "openai/gpt-5.4",
				baseUrl: "https://openrouter.ai/api/v1",
			},
		]);
		fetchKanbanProviderModelsMock.mockResolvedValue([
			{
				id: "openai/gpt-5.4",
				name: "GPT-5.4",
				supportsReasoningEffort: true,
			},
		]);

		await act(async () => {
			root.render(
				<HookHarness
					open={true}
					workspaceId="workspace-1"
					config={config}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushAsyncWork();
		});

		await act(async () => {
			await flushAsyncWork();
		});

		expect(requireSnapshot(latestSnapshot).selectedModelSupportsReasoningEffort).toBe(true);
	});
});
