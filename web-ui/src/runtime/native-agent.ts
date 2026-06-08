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

/**
 * Returns true only when the selected provider is the Kanban managed OAuth
 * provider **and** an access token is configured.  This is stricter than
 * {@link isKanbanProviderAuthenticated} which accepts any configured provider
 * (Claude API key, Codex, etc.).
 *
 * Use this for features that require a Kanban-issued token (e.g. Featurebase
 * JWT authentication).
 */
export function isKanbanOauthAuthenticated(settings: RuntimeKanbanProviderSettings | null | undefined): boolean {
	if (!settings) {
		return false;
	}
	return (
		settings.oauthProvider === "cline" &&
		settings.oauthAccessTokenConfigured === true &&
		settings.oauthRefreshTokenConfigured === true
	);
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
