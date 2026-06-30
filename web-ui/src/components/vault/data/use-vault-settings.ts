import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeVaultMode } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseVaultSettingsResult {
	vaultMode: RuntimeVaultMode;
	agentDatabaseAccessEnabled: boolean;
	isLoading: boolean;
	errorMessage: string | null;
	isMutating: boolean;
	setVaultMode: (next: RuntimeVaultMode) => Promise<void>;
	setAgentDatabaseAccessEnabled: (next: boolean) => Promise<void>;
}

/**
 * Owns the workspace's vault settings: reads the vault-takeover mode via
 * `workspace.getVaultSettings` and changes it through `workspace.updateVaultSettings`,
 * refetching afterwards. Self-contained (not part of the workspace-state payload),
 * mirroring {@link useVaultViews}. Idle when no workspace is selected.
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

	const setVaultMode = useCallback(
		async (next: RuntimeVaultMode): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			setIsMutating(true);
			try {
				await getRuntimeTrpcClient(workspaceId).workspace.updateVaultSettings.mutate({ vaultMode: next });
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
		vaultMode: query.data?.vaultMode ?? "off",
		agentDatabaseAccessEnabled: query.data?.agentDatabaseAccessEnabled ?? false,
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Could not load vault settings.") : null,
		isMutating,
		setVaultMode,
		setAgentDatabaseAccessEnabled,
	};
}
