import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeExtraPushRemote } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface SaveExtraPushRemotesResult {
	ok: boolean;
	error?: string;
}

export interface UseExtraPushRemotesResult {
	/** The workspace's configured mirror push remotes, or null until loaded. */
	remotes: RuntimeExtraPushRemote[] | null;
	isLoading: boolean;
	isSaving: boolean;
	/** Persists the full list via `workspace.updateVaultSettings`, then refetches. Reports failure instead of throwing. */
	save: (remotes: RuntimeExtraPushRemote[]) => Promise<SaveExtraPushRemotesResult>;
}

/**
 * Owns the workspace's extra "mirror" push remotes for the Settings dialog: reads them
 * from `workspace.getVaultSettings` (the `extraPushRemotes` field) and writes the full
 * list back through `workspace.updateVaultSettings`, which merges so this never clobbers
 * the vault-mode setting. Authentication is never handled here — pushes reuse the same
 * per-host git credentials as `origin`. Idle when no workspace is selected.
 */
export function useExtraPushRemotes(workspaceId: string | null): UseExtraPushRemotesResult {
	const [isSaving, setIsSaving] = useState(false);
	const enabled = workspaceId !== null;

	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		const result = await getRuntimeTrpcClient(workspaceId).workspace.getVaultSettings.query();
		return result.settings.extraPushRemotes;
	}, [workspaceId]);

	const query = useTrpcQuery({ enabled, queryFn, retainDataOnError: true });

	const save = useCallback(
		async (remotes: RuntimeExtraPushRemote[]): Promise<SaveExtraPushRemotesResult> => {
			if (!workspaceId) {
				return { ok: false, error: "Missing workspace." };
			}
			setIsSaving(true);
			try {
				await getRuntimeTrpcClient(workspaceId).workspace.updateVaultSettings.mutate({ extraPushRemotes: remotes });
				await query.refetch();
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			} finally {
				setIsSaving(false);
			}
		},
		[workspaceId, query],
	);

	return {
		remotes: query.data ?? null,
		isLoading: query.isLoading,
		isSaving,
		save,
	};
}
