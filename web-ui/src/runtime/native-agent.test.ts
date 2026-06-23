import { describe, expect, it } from "vitest";

import {
	getTaskAgentNavbarHint,
	isKanbanProviderAuthenticated,
	isNativeAgentSelected,
	isTaskAgentSetupSatisfied,
	resolveEffectiveTaskAgentId,
	selectLatestTaskChatMessageForTask,
	selectTaskChatMessagesForTask,
} from "@/runtime/native-agent";
import type { RuntimeConfigResponse, RuntimeStateStreamTaskChatMessage } from "@/runtime/types";

function createRuntimeConfigResponse(
	selectedAgentId: RuntimeConfigResponse["selectedAgentId"],
	overrides?: Partial<RuntimeConfigResponse>,
): RuntimeConfigResponse {
	const nextConfig: RuntimeConfigResponse = {
		selectedAgentId,
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: selectedAgentId === "pi" ? null : selectedAgentId,
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project/.kanban/kanban/config.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: ["claude", "codex"],
		agents: [
			{
				id: "pi",
				label: "Pi",
				binary: "pi",
				command: "pi",
				defaultArgs: [],
				installed: false,
				configured: true,
			},
			{
				id: "claude",
				label: "Claude Code",
				binary: "claude",
				command: "claude",
				defaultArgs: [],
				installed: true,
				configured: true,
			},
		],
		shortcuts: [],
		kanbanProviderSettings: {
			providerId: "anthropic",
			modelId: "sonnet",
			baseUrl: null,
			apiKeyConfigured: true,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
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
	return {
		...nextConfig,
		...overrides,
	};
}

function createLatestTaskChatMessage(taskId: string): RuntimeStateStreamTaskChatMessage {
	return {
		type: "task_chat_message",
		workspaceId: "workspace-1",
		taskId,
		message: {
			id: "message-1",
			role: "assistant",
			content: "Hello",
			createdAt: Date.now(),
			meta: null,
		},
	};
}

describe("native-agent helpers", () => {
	it("treats pi as the native chat agent", () => {
		expect(isNativeAgentSelected("pi")).toBe(true);
		expect(isNativeAgentSelected("codex")).toBe(false);
	});

	describe("resolveEffectiveTaskAgentId", () => {
		it("prefers the live session agent over card and selected", () => {
			expect(
				resolveEffectiveTaskAgentId({
					sessionAgentId: "claude",
					cardAgentId: "codex",
					selectedAgentId: "pi",
				}),
			).toBe("claude");
		});

		it("falls back to the card agent when there is no session agent", () => {
			expect(
				resolveEffectiveTaskAgentId({
					sessionAgentId: null,
					cardAgentId: "claude",
					selectedAgentId: "pi",
				}),
			).toBe("claude");
			expect(
				resolveEffectiveTaskAgentId({
					sessionAgentId: undefined,
					cardAgentId: "claude",
					selectedAgentId: "pi",
				}),
			).toBe("claude");
		});

		it("falls back to the globally-selected agent when neither session nor card has one", () => {
			expect(
				resolveEffectiveTaskAgentId({
					sessionAgentId: null,
					cardAgentId: undefined,
					selectedAgentId: "pi",
				}),
			).toBe("pi");
		});

		it("returns null when nothing resolves an agent", () => {
			expect(
				resolveEffectiveTaskAgentId({
					sessionAgentId: null,
					cardAgentId: undefined,
					selectedAgentId: null,
				}),
			).toBeNull();
		});

		it("routes a claude task to the terminal transport even when pi is globally selected", () => {
			// Regression: commit/auto-commit must follow the task's actual agent,
			// not the global selection (otherwise the pi-only chat endpoint errors
			// with "Task chat session is not running." for a claude task).
			const effectiveAgentId = resolveEffectiveTaskAgentId({
				sessionAgentId: "claude",
				cardAgentId: undefined,
				selectedAgentId: "pi",
			});
			expect(isNativeAgentSelected(effectiveAgentId)).toBe(false);
		});
	});

	it("treats selected pi as task-ready when pi authentication is configured", () => {
		expect(isTaskAgentSetupSatisfied(createRuntimeConfigResponse("pi"))).toBe(true);
		expect(isTaskAgentSetupSatisfied(null)).toBeNull();
	});

	it("requires setup when pi is selected and pi authentication is missing", () => {
		const config = createRuntimeConfigResponse("pi", {
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
			kanbanProviderSettings: {
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
		});
		expect(isTaskAgentSetupSatisfied(config)).toBe(false);
	});

	it("falls back to other installed launch-supported agents when pi auth is missing", () => {
		const config = createRuntimeConfigResponse("pi", {
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
				{
					id: "codex",
					label: "OpenAI Codex",
					binary: "codex",
					command: "codex",
					defaultArgs: [],
					installed: true,
					configured: false,
				},
			],
			kanbanProviderSettings: {
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
		});
		expect(isTaskAgentSetupSatisfied(config)).toBe(true);
	});

	it("does not show the navbar setup hint when pi is configured through the native SDK path", () => {
		expect(getTaskAgentNavbarHint(createRuntimeConfigResponse("pi"))).toBeUndefined();
	});

	it("shows the navbar setup hint when no task agent path is ready", () => {
		const config = createRuntimeConfigResponse("pi", {
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
			kanbanProviderSettings: {
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
		});
		expect(getTaskAgentNavbarHint(config)).toBe("No agent configured");
		expect(
			getTaskAgentNavbarHint(config, {
				shouldUseNavigationPath: true,
			}),
		).toBeUndefined();
	});

	it("checks for a provider selection when determining pi authentication", () => {
		expect(
			isKanbanProviderAuthenticated({
				providerId: null,
				modelId: null,
				baseUrl: null,
				apiKeyConfigured: true,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			}),
		).toBe(false);
		expect(
			isKanbanProviderAuthenticated({
				providerId: "anthropic",
				modelId: null,
				baseUrl: null,
				apiKeyConfigured: true,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			}),
		).toBe(true);
	});

	it("ignores non-launch agents when checking native CLI availability", () => {
		const config = createRuntimeConfigResponse("claude");
		config.agents = [
			{
				id: "gemini",
				label: "Gemini CLI",
				binary: "gemini",
				command: "gemini",
				defaultArgs: [],
				installed: true,
				configured: false,
			},
		];
		expect(isTaskAgentSetupSatisfied(config)).toBe(false);
	});

	it("selects the latest incoming chat message only for the matching task", () => {
		const messageEvent = createLatestTaskChatMessage("task-1");
		expect(selectLatestTaskChatMessageForTask("task-1", messageEvent)).toEqual(messageEvent.message);
		expect(selectLatestTaskChatMessageForTask("task-2", messageEvent)).toBeNull();
		expect(selectLatestTaskChatMessageForTask(null, messageEvent)).toBeNull();
	});

	it("selects the streamed task chat transcript for the matching task", () => {
		const messageEvent = createLatestTaskChatMessage("task-1");
		expect(
			selectTaskChatMessagesForTask("task-1", {
				"task-1": [messageEvent.message],
			}),
		).toEqual([messageEvent.message]);
		expect(selectTaskChatMessagesForTask("task-2", { "task-1": [messageEvent.message] })).toBeNull();
		expect(selectTaskChatMessagesForTask(null, { "task-1": [messageEvent.message] })).toBeNull();
	});
});
