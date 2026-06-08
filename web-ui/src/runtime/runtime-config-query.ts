// Browser-side query helpers for runtime settings and Kanban actions.
// Keep TRPC request details here so components and controller hooks can focus
// on state orchestration instead of transport plumbing.
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentId,
	RuntimeKanbanAccountBalanceResponse,
	RuntimeKanbanAccountOrganizationsResponse,
	RuntimeKanbanAccountProfileResponse,
	RuntimeKanbanAccountSwitchResponse,
	RuntimeKanbanAddProviderResponse,
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
	RuntimeKanbanProviderCapability,
	RuntimeKanbanProviderCatalogItem,
	RuntimeKanbanProviderModel,
	RuntimeKanbanProviderSettings,
	RuntimeReasoningEffort,
	RuntimeKanbanUpdateProviderResponse,
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

export async function saveKanbanProviderSettings(
	workspaceId: string | null,
	input: {
		providerId: string;
		modelId?: string | null;
		apiKey?: string | null;
		baseUrl?: string | null;
		reasoningEffort?: RuntimeReasoningEffort | null;
		region?: string | null;
		aws?: {
			accessKey?: string | null;
			secretKey?: string | null;
			sessionToken?: string | null;
			region?: string | null;
			profile?: string | null;
			authentication?: "iam" | "api-key" | "profile" | null;
			endpoint?: string | null;
		};
		gcp?: {
			projectId?: string | null;
			region?: string | null;
		};
	},
): Promise<RuntimeKanbanProviderSettings> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.saveKanbanProviderSettings.mutate(input);
}

export async function addKanbanProvider(
	workspaceId: string | null,
	input: {
		providerId: string;
		name: string;
		baseUrl: string;
		apiKey?: string | null;
		headers?: Record<string, string>;
		timeoutMs?: number;
		models: string[];
		defaultModelId?: string | null;
		modelsSourceUrl?: string | null;
		capabilities?: RuntimeKanbanProviderCapability[];
	},
): Promise<RuntimeKanbanAddProviderResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.addKanbanProvider.mutate(input);
}

export async function updateKanbanProvider(
	workspaceId: string | null,
	input: {
		providerId: string;
		name?: string;
		baseUrl?: string;
		apiKey?: string | null;
		headers?: Record<string, string> | null;
		timeoutMs?: number | null;
		models?: string[];
		defaultModelId?: string | null;
		modelsSourceUrl?: string | null;
		capabilities?: RuntimeKanbanProviderCapability[];
	},
): Promise<RuntimeKanbanUpdateProviderResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.updateKanbanProvider.mutate(input);
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
