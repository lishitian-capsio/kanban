// Owns the agent-profile library for a single agent, scoped to a workspace.
//
// The composer's profile control consumes this: it loads the agent's named
// config profiles, exposes the currently selected one, and runs the CRUD +
// select mutations through the 6c49b tRPC layer. Every mutation echoes the
// post-mutation snapshot, so we adopt that directly instead of refetching —
// switching/saving is effective on the next agent launch (the backend bumps
// the session context version).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import {
	buildCopyProfileName,
	duplicateProfileCreateInput,
	selectProfileForAgent,
} from "@/hooks/agent-profile-utils";
import {
	createAgentProfile as createAgentProfileRequest,
	deleteAgentProfile as deleteAgentProfileRequest,
	fetchAgentProfiles,
	selectAgentProfile as selectAgentProfileRequest,
	updateAgentProfile as updateAgentProfileRequest,
} from "@/runtime/agent-profile-query";
import type {
	RuntimeAgentId,
	RuntimeAgentProfile,
	RuntimeAgentProfileCreateRequest,
	RuntimeAgentProfileMutationResponse,
	RuntimeAgentProfileUpdateRequest,
} from "@/runtime/types";

export interface AgentProfileActionResult {
	ok: boolean;
	message?: string;
	profile?: RuntimeAgentProfile | null;
}

/** Create payload minus agentId — the hook injects its bound agent. */
export type AgentProfileCreateInput = Omit<RuntimeAgentProfileCreateRequest, "agentId">;

export interface UseAgentProfilesOptions {
	workspaceId: string | null;
	agentId: RuntimeAgentId | null;
	enabled?: boolean;
}

export interface UseAgentProfilesResult {
	profiles: RuntimeAgentProfile[];
	selectedProfile: RuntimeAgentProfile | null;
	selectedProfileId: string | null;
	isLoading: boolean;
	refresh: () => Promise<void>;
	selectProfile: (profileId: string | null) => Promise<AgentProfileActionResult>;
	createProfile: (input: AgentProfileCreateInput) => Promise<AgentProfileActionResult>;
	updateProfile: (input: RuntimeAgentProfileUpdateRequest) => Promise<AgentProfileActionResult>;
	deleteProfile: (id: string) => Promise<AgentProfileActionResult>;
	duplicateProfile: (id: string) => Promise<AgentProfileActionResult>;
}

const DISABLED_RESULT: AgentProfileActionResult = {
	ok: false,
	message: "Select a workspace and agent before managing profiles.",
};

export function useAgentProfiles(options: UseAgentProfilesOptions): UseAgentProfilesResult {
	const { workspaceId, agentId, enabled = true } = options;
	const isActive = enabled && workspaceId !== null && agentId !== null;

	const [profiles, setProfiles] = useState<RuntimeAgentProfile[]>([]);
	const [selectedByAgent, setSelectedByAgent] = useState<Record<string, string>>({});
	const [isLoading, setIsLoading] = useState(false);
	const loadRequestIdRef = useRef(0);

	const applySnapshot = useCallback(
		(snapshot: { profiles: RuntimeAgentProfile[]; selectedByAgent: Record<string, string> }) => {
			if (agentId === null) {
				return;
			}
			setProfiles(snapshot.profiles.filter((profile) => profile.agentId === agentId));
			setSelectedByAgent(snapshot.selectedByAgent);
		},
		[agentId],
	);

	const refresh = useCallback(async (): Promise<void> => {
		if (!isActive || agentId === null) {
			return;
		}
		loadRequestIdRef.current += 1;
		const requestId = loadRequestIdRef.current;
		setIsLoading(true);
		try {
			const response = await fetchAgentProfiles(workspaceId, agentId);
			if (loadRequestIdRef.current === requestId) {
				applySnapshot(response);
			}
		} catch (error) {
			if (loadRequestIdRef.current === requestId) {
				notifyError(error instanceof Error ? error.message : String(error));
				applySnapshot({ profiles: [], selectedByAgent: {} });
			}
		} finally {
			if (loadRequestIdRef.current === requestId) {
				setIsLoading(false);
			}
		}
	}, [agentId, applySnapshot, isActive, workspaceId]);

	useEffect(() => {
		if (!isActive) {
			loadRequestIdRef.current += 1;
			setProfiles([]);
			setSelectedByAgent({});
			setIsLoading(false);
			return;
		}
		void refresh();
	}, [isActive, refresh]);

	const runMutation = useCallback(
		async (
			mutate: () => Promise<RuntimeAgentProfileMutationResponse>,
		): Promise<AgentProfileActionResult> => {
			if (!isActive) {
				return DISABLED_RESULT;
			}
			try {
				const response = await mutate();
				applySnapshot(response);
				return { ok: true, profile: response.profile };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
				return { ok: false, message };
			}
		},
		[applySnapshot, isActive],
	);

	const selectProfile = useCallback(
		(profileId: string | null): Promise<AgentProfileActionResult> =>
			runMutation(() => selectAgentProfileRequest(workspaceId, agentId as RuntimeAgentId, profileId)),
		[agentId, runMutation, workspaceId],
	);

	const createProfile = useCallback(
		(input: AgentProfileCreateInput): Promise<AgentProfileActionResult> =>
			runMutation(() =>
				createAgentProfileRequest(workspaceId, { ...input, agentId: agentId as RuntimeAgentId }),
			),
		[agentId, runMutation, workspaceId],
	);

	const updateProfile = useCallback(
		(input: RuntimeAgentProfileUpdateRequest): Promise<AgentProfileActionResult> =>
			runMutation(() => updateAgentProfileRequest(workspaceId, input)),
		[runMutation, workspaceId],
	);

	const deleteProfile = useCallback(
		(id: string): Promise<AgentProfileActionResult> =>
			runMutation(() => deleteAgentProfileRequest(workspaceId, id)),
		[runMutation, workspaceId],
	);

	const duplicateProfile = useCallback(
		(id: string): Promise<AgentProfileActionResult> => {
			const source = profiles.find((profile) => profile.id === id);
			if (!source) {
				return Promise.resolve({ ok: false, message: "Profile no longer exists." });
			}
			const name = buildCopyProfileName(
				profiles.map((profile) => profile.name),
				source.name,
			);
			return runMutation(() => createAgentProfileRequest(workspaceId, duplicateProfileCreateInput(source, name)));
		},
		[profiles, runMutation, workspaceId],
	);

	const selectedProfile = useMemo(
		() => (agentId === null ? null : selectProfileForAgent(profiles, selectedByAgent, agentId)),
		[agentId, profiles, selectedByAgent],
	);
	const selectedProfileId = selectedProfile?.id ?? null;

	return {
		profiles,
		selectedProfile,
		selectedProfileId,
		isLoading,
		refresh,
		selectProfile,
		createProfile,
		updateProfile,
		deleteProfile,
		duplicateProfile,
	};
}
