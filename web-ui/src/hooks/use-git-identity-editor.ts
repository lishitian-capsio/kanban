import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { TaskOwner } from "@/types";

export interface GitIdentityDraft {
	name: string;
	email: string;
}

export interface SaveGitIdentityResult {
	ok: boolean;
	error?: string;
}

export interface UseGitIdentityEditorResult {
	/** The workspace repo's current git identity (`user.name`/`user.email`), or null when none is set. */
	identity: TaskOwner | null;
	isLoading: boolean;
	isSaving: boolean;
	/** Writes the real repo-local git config, then refetches. Reports failure instead of throwing. */
	save: (draft: GitIdentityDraft) => Promise<SaveGitIdentityResult>;
}

/**
 * Owns the workspace repo's git identity for the Settings dialog: reads it via
 * `workspace.getGitUserIdentity` and writes the **real** repo-local `git config`
 * through `workspace.setGitUserIdentity`, refetching afterwards. Self-contained (not
 * part of the workspace-state payload), mirroring {@link useVaultSettings}. Changing
 * this is the source the task-owner default already reads, so new tasks pick it up
 * with no extra wiring. Idle when no workspace is selected.
 */
export function useGitIdentityEditor(workspaceId: string | null): UseGitIdentityEditorResult {
	const [isSaving, setIsSaving] = useState(false);
	const enabled = workspaceId !== null;

	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		const result = await getRuntimeTrpcClient(workspaceId).workspace.getGitUserIdentity.query();
		return result.identity;
	}, [workspaceId]);

	const query = useTrpcQuery({ enabled, queryFn, retainDataOnError: true });

	const save = useCallback(
		async (draft: GitIdentityDraft): Promise<SaveGitIdentityResult> => {
			if (!workspaceId) {
				return { ok: false, error: "Missing workspace." };
			}
			setIsSaving(true);
			try {
				await getRuntimeTrpcClient(workspaceId).workspace.setGitUserIdentity.mutate({
					name: draft.name,
					email: draft.email,
				});
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
		identity: query.data ?? null,
		isLoading: query.isLoading,
		isSaving,
		save,
	};
}
