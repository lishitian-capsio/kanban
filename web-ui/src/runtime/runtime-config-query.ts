// Browser-side query helpers for runtime settings and Kanban actions.
// Keep TRPC request details here so components and controller hooks can focus
// on state orchestration instead of transport plumbing.
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentExecutablePathResponse,
	RuntimeAgentExecutablePathSaveRequest,
	RuntimeAgentId,
	RuntimeAgentProviderConfig,
	RuntimeAgentProviderConfigListResponse,
	RuntimeAgentProviderMutationRequest,
	RuntimeAgentProviderMutationResponse,
	RuntimeAgentProviderSetListResponse,
	RuntimeConfigResponse,
	RuntimeDebugResetAllStateResponse,
	RuntimeGiteeAuthStatus,
	RuntimeGiteeLogoutResponse,
	RuntimeGiteeSetTokenResponse,
	RuntimeGithubAuthStatus,
	RuntimeGithubBeginLoginResponse,
	RuntimeGithubLogoutResponse,
	RuntimeGithubPendingLoginResponse,
	RuntimeGithubPollLoginResponse,
	RuntimeKanbanMcpAuthStatusResponse,
	RuntimeKanbanMcpOAuthResponse,
	RuntimeKanbanMcpServer,
	RuntimeKanbanMcpSettingsResponse,
	RuntimeKanbanProviderCatalogItem,
	RuntimeKanbanProviderModel,
	RuntimeProjectShortcut,
	RuntimeRunUpdateResponse,
	RuntimeSttSaveRequest,
	RuntimeSttStatus,
	RuntimeSttTranscribeRequest,
	RuntimeSttTranscribeResponse,
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

export async function fetchKanbanProviderModels(
	workspaceId: string | null,
	providerId: string,
): Promise<RuntimeKanbanProviderModel[]> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	const response = await trpcClient.runtime.getKanbanProviderModels.query({ providerId });
	return response.models;
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

export async function fetchAgentProviderSets(workspaceId: string | null): Promise<RuntimeAgentProviderSetListResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.listAgentProviders.query();
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

export async function setAgentExecutablePath(
	workspaceId: string | null,
	input: RuntimeAgentExecutablePathSaveRequest,
): Promise<RuntimeAgentExecutablePathResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.setAgentExecutablePath.mutate(input);
}

// ── Kanban-hosted GitHub git auth ────────────────────────────────────────────
// Machine-global (no workspace scope); the `github` router is a sibling of `runtime`.
// The OAuth token never crosses the wire — only the secret-free status + device-flow
// handshake do.

export async function fetchGithubAuthStatus(workspaceId: string | null): Promise<RuntimeGithubAuthStatus> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.github.status.query();
}

export async function beginGithubLogin(workspaceId: string | null): Promise<RuntimeGithubBeginLoginResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.github.beginLogin.mutate();
}

/** The in-flight login (if any) to resume after a UI refresh / brief disconnect. */
export async function fetchGithubPendingLogin(workspaceId: string | null): Promise<RuntimeGithubPendingLoginResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.github.pendingLogin.query();
}

export async function pollGithubLogin(workspaceId: string | null): Promise<RuntimeGithubPollLoginResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	// The device code lives server-side now; the UI polls the server-held pending login.
	return await trpcClient.github.pollLogin.mutate();
}

/** Discard the in-flight login server-side (explicit Cancel). */
export async function cancelGithubLogin(workspaceId: string | null): Promise<void> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	await trpcClient.github.cancelLogin.mutate();
}

export async function logoutGithub(workspaceId: string | null): Promise<RuntimeGithubLogoutResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.github.logout.mutate();
}

// ── Kanban-hosted Gitee git auth ─────────────────────────────────────────────
// Machine-global (no workspace scope); the `gitee` router is a sibling of `runtime`. Gitee has
// no device flow (cf0d6): the PAT is pasted, stored server-side, and never crosses the wire on
// read — only the secret-free status does.

export async function fetchGiteeAuthStatus(workspaceId: string | null): Promise<RuntimeGiteeAuthStatus> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.gitee.status.query();
}

export async function setGiteeToken(
	workspaceId: string | null,
	input: { token: string; username?: string },
): Promise<RuntimeGiteeSetTokenResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.gitee.setToken.mutate(input);
}

export async function logoutGitee(workspaceId: string | null): Promise<RuntimeGiteeLogoutResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.gitee.logout.mutate();
}

// ── Speech-to-text (STT) config + transcription ──────────────────────────────
// Machine-global (no workspace scope); the `stt` router is a sibling of `runtime`.
// The API key never crosses the wire — status is masked; audio uploads as base64.

export async function fetchSttStatus(workspaceId: string | null): Promise<RuntimeSttStatus> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.stt.status.query();
}

export async function saveSttConfig(
	workspaceId: string | null,
	request: RuntimeSttSaveRequest,
): Promise<RuntimeSttStatus> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.stt.save.mutate(request);
}

export async function clearSttConfig(workspaceId: string | null): Promise<RuntimeSttStatus> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.stt.clear.mutate();
}

export async function transcribeAudioClip(
	workspaceId: string | null,
	request: RuntimeSttTranscribeRequest,
): Promise<RuntimeSttTranscribeResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.stt.transcribe.mutate(request);
}

// ── Remote model fetching ──────────────────────────────────────────────────

export async function fetchRemoteProviderModels(
	workspaceId: string | null,
	input: { baseUrl: string; protocol: "anthropic" | "openai"; apiKey?: string },
): Promise<{ models: string[] }> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.fetchRemoteProviderModels.mutate(input);
}
