// Browser-side query helpers for per-agent config profiles (task 6c49b foundation).
// Mirrors the runtime-config-query pattern: keep TRPC transport here so hooks and
// components orchestrate state without knowing about the wire layer.
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentId,
	RuntimeAgentProfileCreateRequest,
	RuntimeAgentProfileListResponse,
	RuntimeAgentProfileMutationResponse,
	RuntimeAgentProfileUpdateRequest,
} from "@/runtime/types";

export async function fetchAgentProfiles(
	workspaceId: string | null,
	agentId?: RuntimeAgentId,
): Promise<RuntimeAgentProfileListResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.listAgentProfiles.query(agentId ? { agentId } : {});
}

export async function createAgentProfile(
	workspaceId: string | null,
	input: RuntimeAgentProfileCreateRequest,
): Promise<RuntimeAgentProfileMutationResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.createAgentProfile.mutate(input);
}

export async function updateAgentProfile(
	workspaceId: string | null,
	input: RuntimeAgentProfileUpdateRequest,
): Promise<RuntimeAgentProfileMutationResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.updateAgentProfile.mutate(input);
}

export async function deleteAgentProfile(
	workspaceId: string | null,
	id: string,
): Promise<RuntimeAgentProfileMutationResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.deleteAgentProfile.mutate({ id });
}

export async function selectAgentProfile(
	workspaceId: string | null,
	agentId: RuntimeAgentId,
	profileId: string | null,
): Promise<RuntimeAgentProfileMutationResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.selectAgentProfile.mutate({ agentId, profileId });
}
