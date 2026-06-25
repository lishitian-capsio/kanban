import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface SaveGitRemoteResult {
	ok: boolean;
	error?: string;
}

export interface UseGitRemoteEditorResult {
	/** The workspace repo's current `origin` remote URL, or null when none is configured. */
	url: string | null;
	isLoading: boolean;
	isSaving: boolean;
	/** Adds/updates the real `origin` remote, then refetches. Reports failure instead of throwing. */
	save: (url: string) => Promise<SaveGitRemoteResult>;
}

/**
 * Owns the workspace repo's `origin` remote URL for the Settings dialog: reads it via
 * `workspace.getGitRemote` and writes the **real** `git remote` through
 * `workspace.setGitRemote`, refetching afterwards. Self-contained (not part of the
 * workspace-state payload), mirroring {@link useGitIdentityEditor}. Authentication is
 * never handled here — credentials stay with the system git credential helper / SSH
 * agent. Idle when no workspace is selected.
 */
export function useGitRemoteEditor(workspaceId: string | null): UseGitRemoteEditorResult {
	const [isSaving, setIsSaving] = useState(false);
	const enabled = workspaceId !== null;

	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		const result = await getRuntimeTrpcClient(workspaceId).workspace.getGitRemote.query();
		return result.url;
	}, [workspaceId]);

	const query = useTrpcQuery({ enabled, queryFn, retainDataOnError: true });

	const save = useCallback(
		async (url: string): Promise<SaveGitRemoteResult> => {
			if (!workspaceId) {
				return { ok: false, error: "Missing workspace." };
			}
			setIsSaving(true);
			try {
				await getRuntimeTrpcClient(workspaceId).workspace.setGitRemote.mutate({ url });
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
		url: query.data ?? null,
		isLoading: query.isLoading,
		isSaving,
		save,
	};
}
