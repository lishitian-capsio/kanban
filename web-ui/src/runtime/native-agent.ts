import { isRuntimeAgentLaunchSupported } from "@runtime-agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeKanbanProviderSettings,
	RuntimeConfigResponse,
	RuntimeStateStreamTaskChatMessage,
	RuntimeTaskChatMessage,
} from "@/runtime/types";

export function isNativeAgentSelected(agentId: RuntimeAgentId | null | undefined): boolean {
	return agentId === "pi";
}

/**
 * Resolve the agent that actually backs a task's session, preferring the live
 * session summary, then the card's stored agent, then the globally-selected
 * agent. Mirrors the chat-panel resolution so per-task routing (kanban chat vs
 * terminal PTY) is consistent across the UI instead of keying off the global
 * `selectedAgentId`.
 */
export function resolveEffectiveTaskAgentId(input: {
	sessionAgentId: RuntimeAgentId | null | undefined;
	cardAgentId: RuntimeAgentId | null | undefined;
	selectedAgentId: RuntimeAgentId | null | undefined;
}): RuntimeAgentId | null {
	return input.sessionAgentId ?? input.cardAgentId ?? input.selectedAgentId ?? null;
}

export function getRuntimeKanbanProviderSettings(
	config: Pick<RuntimeConfigResponse, "kanbanProviderSettings"> | null | undefined,
): RuntimeKanbanProviderSettings {
	return (
		config?.kanbanProviderSettings ?? {
			providerId: null,
			modelId: null,
			baseUrl: null,
			reasoningEffort: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		}
	);
}

export function isKanbanProviderAuthenticated(settings: RuntimeKanbanProviderSettings | null | undefined): boolean {
	if (!settings) {
		return false;
	}
	const hasProviderSelection =
		(settings.providerId?.trim().length ?? 0) > 0 || (settings.oauthProvider?.trim().length ?? 0) > 0;
	if (!hasProviderSelection) {
		return false;
	}
	return settings.apiKeyConfigured || settings.oauthAccessTokenConfigured;
}

export function isTaskAgentSetupSatisfied(
	config: Pick<RuntimeConfigResponse, "selectedAgentId" | "agents" | "kanbanProviderSettings"> | null | undefined,
): boolean | null {
	if (!config) {
		return null;
	}
	if (isNativeAgentSelected(config.selectedAgentId)) {
		if (isKanbanProviderAuthenticated(getRuntimeKanbanProviderSettings(config))) {
			return true;
		}
		return config.agents.some(
			(agent) => agent.id !== "pi" && isRuntimeAgentLaunchSupported(agent.id) && agent.installed,
		);
	}
	return config.agents.some((agent) => isRuntimeAgentLaunchSupported(agent.id) && agent.installed);
}

export function getTaskAgentNavbarHint(
	config: Pick<RuntimeConfigResponse, "selectedAgentId" | "agents" | "kanbanProviderSettings"> | null | undefined,
	options?: {
		shouldUseNavigationPath?: boolean;
	},
): string | undefined {
	if (options?.shouldUseNavigationPath) {
		return undefined;
	}
	const isTaskAgentReady = isTaskAgentSetupSatisfied(config);
	if (isTaskAgentReady === null || isTaskAgentReady) {
		return undefined;
	}
	return "No agent configured";
}

export function selectLatestTaskChatMessageForTask(
	taskId: string | null | undefined,
	latestTaskChatMessage: RuntimeStateStreamTaskChatMessage | null,
): RuntimeTaskChatMessage | null {
	if (!taskId || !latestTaskChatMessage || latestTaskChatMessage.taskId !== taskId) {
		return null;
	}
	return latestTaskChatMessage.message;
}

export function selectTaskChatMessagesForTask(
	taskId: string | null | undefined,
	taskChatMessagesByTaskId: Record<string, RuntimeTaskChatMessage[]>,
): RuntimeTaskChatMessage[] | null {
	if (!taskId) {
		return null;
	}
	return taskChatMessagesByTaskId[taskId] ?? null;
}
