// Browser-side query helpers for runtime settings and Kanban actions.
// Keep TRPC request details here so components and controller hooks can focus
// on state orchestration instead of transport plumbing.
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentId,
	RuntimeAgentProviderConfig,
	RuntimeAgentProviderConfigListResponse,
	RuntimeAgentProviderMutationRequest,
	RuntimeAgentProviderMutationResponse,
	RuntimeKanbanAccountBalanceResponse,
	RuntimeKanbanAccountOrganizationsResponse,
	RuntimeKanbanAccountProfileResponse,
	RuntimeKanbanAccountSwitchResponse,
	RuntimeKanbanDeviceAuthCompleteRequest,
	RuntimeKanbanDeviceAuthCompleteResponse,
	RuntimeKanbanDeviceAuthStartResponse,
	RuntimeKanbanKanbanAccessResponse,
	RuntimeKanbanMcpAuthStatusResponse,
	RuntimeKanbanMcpOAuthResponse,
	RuntimeKanbanMcpServer,
	RuntimeKanbanMcpSettingsResponse,
	RuntimeKanbanOauthLoginResponse,
	RuntimeKanbanOauthProvider,
	RuntimeKanbanProviderCatalogItem,
	RuntimeKanbanProviderModel,
	RuntimeConfigResponse,
	RuntimeDebugResetAllStateResponse,
	RuntimeFeaturebaseTokenResponse,
	RuntimeProjectShortcut,
	RuntimeRunUpdateResponse,
	RuntimeUpdateStatusResponse,
} from "@/runtime/types";

export async function fetchRuntimeConfig(workspaceId: string | null): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getConfig.query();
}

export async function saveRuntimeConfig(
	workspaceId: string | null,
	nextConfig: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		shortcuts?: RuntimeProjectShortcut[];
		readyForReviewNotificationsEnabled?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
		proxyEnabled?: boolean;
		proxyHost?: string;
		proxyPort?: string;
		proxyUsername?: string;
		proxyPassword?: string;
		noProxy?: string;
	},
): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.saveConfig.mutate(nextConfig);
}

export async function saveAgentProviderConfig(
	workspaceId: string | null,
	agentId: string,
	config: RuntimeAgentProviderConfig,
): Promise<RuntimeAgentProviderMutationResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.saveAgentProviderConfig.mutate({ agentId, config });
}

export async function fetchKanbanProviderCatalog(
	workspaceId: string | null,
): Promise<RuntimeKanbanProviderCatalogItem[]> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response = await trpcClient.runtime.getKanbanProviderCatalog.query();
	return response.providers;
}

export async function fetchKanbanAccountProfile(
	workspaceId: string | null,
): Promise<RuntimeKanbanAccountProfileResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getKanbanAccountProfile.query();
}

export async function fetchKanbanKanbanAccess(workspaceId: string | null): Promise<RuntimeKanbanKanbanAccessResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getKanbanKanbanAccess.query();
}

export async function fetchFeaturebaseToken(workspaceId: string | null): Promise<RuntimeFeaturebaseTokenResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getFeaturebaseToken.query();
}

export async function fetchKanbanProviderModels(
	workspaceId: string | null,
	providerId: string,
): Promise<RuntimeKanbanProviderModel[]> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response = await trpcClient.runtime.getKanbanProviderModels.query({ providerId });
	return response.models;
}

export async function runKanbanProviderOauthLogin(
	workspaceId: string | null,
	input: {
		provider: RuntimeKanbanOauthProvider;
		baseUrl?: string | null;
	},
): Promise<RuntimeKanbanOauthLoginResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.runKanbanProviderOAuthLogin.mutate(input);
}

export async function startKanbanDeviceAuth(workspaceId: string | null): Promise<RuntimeKanbanDeviceAuthStartResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.startKanbanDeviceAuth.mutate();
}

export async function completeKanbanDeviceAuth(
	workspaceId: string | null,
	input: RuntimeKanbanDeviceAuthCompleteRequest,
): Promise<RuntimeKanbanDeviceAuthCompleteResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.completeKanbanDeviceAuth.mutate(input);
}

export async function fetchKanbanMcpSettings(workspaceId: string | null): Promise<RuntimeKanbanMcpSettingsResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getKanbanMcpSettings.query();
}

export async function fetchKanbanMcpAuthStatuses(
	workspaceId: string | null,
): Promise<RuntimeKanbanMcpAuthStatusResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getKanbanMcpAuthStatuses.query();
}

export async function saveKanbanMcpSettings(
	workspaceId: string | null,
	input: {
		servers: RuntimeKanbanMcpServer[];
	},
): Promise<RuntimeKanbanMcpSettingsResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.saveKanbanMcpSettings.mutate(input);
}

export async function runKanbanMcpServerOAuth(
	workspaceId: string | null,
	input: {
		serverName: string;
	},
): Promise<RuntimeKanbanMcpOAuthResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.runKanbanMcpServerOAuth.mutate(input);
}

export async function resetRuntimeDebugState(workspaceId: string | null): Promise<RuntimeDebugResetAllStateResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.resetAllState.mutate();
}

export async function openFileOnHost(workspaceId: string | null, filePath: string): Promise<void> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	await trpcClient.runtime.openFile.mutate({ filePath });
}

export async function fetchKanbanAccountBalance(
	workspaceId: string | null,
): Promise<RuntimeKanbanAccountBalanceResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getKanbanAccountBalance.query();
}

export async function fetchKanbanAccountOrganizations(
	workspaceId: string | null,
): Promise<RuntimeKanbanAccountOrganizationsResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getKanbanAccountOrganizations.query();
}

export async function switchKanbanAccount(
	workspaceId: string | null,
	organizationId: string | null,
): Promise<RuntimeKanbanAccountSwitchResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.switchKanbanAccount.mutate({ organizationId });
}

export async function fetchRuntimeUpdateStatus(workspaceId: string | null): Promise<RuntimeUpdateStatusResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getUpdateStatus.query();
}

export async function runRuntimeUpdateNow(workspaceId: string | null): Promise<RuntimeRunUpdateResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.runUpdateNow.mutate();
}

// ── Agent Provider Config ────────────────────────────────────────────────────

export async function fetchAgentProviderConfigs(
	workspaceId: string | null,
): Promise<RuntimeAgentProviderConfigListResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.listAgentProviderConfigs.query();
}

export async function addProviderToAgent(
	workspaceId: string | null,
	input: RuntimeAgentProviderMutationRequest,
): Promise<RuntimeAgentProviderMutationResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.addProviderToAgent.mutate(input);
}

export async function removeProviderFromAgent(
	workspaceId: string | null,
	input: RuntimeAgentProviderMutationRequest,
): Promise<RuntimeAgentProviderMutationResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.removeProviderFromAgent.mutate(input);
}

export async function selectAgentProvider(
	workspaceId: string | null,
	input: RuntimeAgentProviderMutationRequest,
): Promise<RuntimeAgentProviderMutationResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.selectAgentProvider.mutate(input);
}

// ── Remote model fetching ──────────────────────────────────────────────────

export async function fetchRemoteProviderModels(
	workspaceId: string | null,
	input: { baseUrl: string; protocol: "anthropic" | "openai"; apiKey?: string },
): Promise<{ models: string[] }> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.fetchRemoteProviderModels.mutate(input);
}
