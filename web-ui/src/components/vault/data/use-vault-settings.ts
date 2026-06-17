import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseVaultSettingsResult {
	managed: boolean;
	isLoading: boolean;
	errorMessage: string | null;
	isMutating: boolean;
	setManaged: (next: boolean) => Promise<void>;
}

/**
 * Owns the workspace's vault settings: reads the vault-takeover switch via
 * `workspace.getVaultSettings` and flips it through `workspace.updateVaultSettings`,
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

	const setManaged = useCallback(
		async (next: boolean): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			setIsMutating(true);
			try {
				await getRuntimeTrpcClient(workspaceId).workspace.updateVaultSettings.mutate({ managed: next });
				await query.refetch();
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, query],
	);

	return {
		managed: query.data?.managed ?? false,
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Could not load vault settings.") : null,
		isMutating,
		setManaged,
	};
}
