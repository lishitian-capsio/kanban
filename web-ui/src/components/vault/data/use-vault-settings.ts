import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseVaultSettingsResult {
	agentVaultManagementEnabled: boolean;
	agentDatabaseAccessEnabled: boolean;
	isLoading: boolean;
	errorMessage: string | null;
	isMutating: boolean;
	setAgentVaultManagementEnabled: (next: boolean) => Promise<void>;
	setAgentDatabaseAccessEnabled: (next: boolean) => Promise<void>;
}

/**
 * Owns the workspace's vault settings: reads the agent vault-management and
 * database-access switches via `workspace.getVaultSettings` and changes them through
 * `workspace.updateVaultSettings`, refetching afterwards. Self-contained (not part of
 * the workspace-state payload), mirroring {@link useVaultViews}. Idle when no workspace
 * is selected.
 */
export function useVaultSettings(workspaceId: string | null): UseVaultSettingsResult {
	const [isMutating, setIsMutating] = useState(false);
	const enabled = workspaceId !== null;

	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		const result = await getRuntimeTrpcClient(workspaceId).workspace.getVaultSettings.query();
		return result.settings;
	}, [workspaceId]);

	const query = useTrpcQuery({ enabled, queryFn, retainDataOnError: true });

	const setAgentVaultManagementEnabled = useCallback(
		async (next: boolean): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			setIsMutating(true);
			try {
				await getRuntimeTrpcClient(workspaceId).workspace.updateVaultSettings.mutate({
					agentVaultManagementEnabled: next,
				});
				await query.refetch();
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, query],
	);

	const setAgentDatabaseAccessEnabled = useCallback(
		async (next: boolean): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			setIsMutating(true);
			try {
				await getRuntimeTrpcClient(workspaceId).workspace.updateVaultSettings.mutate({
					agentDatabaseAccessEnabled: next,
				});
				await query.refetch();
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, query],
	);

	return {
		agentVaultManagementEnabled: query.data?.agentVaultManagementEnabled ?? false,
		agentDatabaseAccessEnabled: query.data?.agentDatabaseAccessEnabled ?? false,
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Could not load vault settings.") : null,
		isMutating,
		setAgentVaultManagementEnabled,
		setAgentDatabaseAccessEnabled,
	};
}
