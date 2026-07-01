import { useMemo } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFsDeleteEntryResponse, RuntimeFsEntryMutationResponse } from "@/runtime/types";

export interface UseFsMutationsResult {
	/** Create a new empty file or directory under an existing parent. */
	createEntry: (path: string, kind: "file" | "dir") => Promise<RuntimeFsEntryMutationResponse>;
	/** Rename an entry within its own directory. */
	rename: (path: string, newName: string) => Promise<RuntimeFsEntryMutationResponse>;
	/** Move an entry to a new full destination path (used by drag-and-drop). */
	move: (fromPath: string, toPath: string) => Promise<RuntimeFsEntryMutationResponse>;
	/** Delete a file, or a directory (recursive required when non-empty). */
	deleteEntry: (path: string, recursive?: boolean) => Promise<RuntimeFsDeleteEntryResponse>;
}

const MISSING_WORKSPACE = "No workspace is selected.";

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/**
 * Thin wrapper over the `workspaceFs` mutation procedures. Each call resolves to
 * the backend's `{ ok, error?, entry? }` envelope; a transport failure is
 * normalized to the same `{ ok: false, error }` shape so callers only branch on
 * `ok`. Toasting + incremental tree refresh are the caller's responsibility.
 */
export function useFsMutations(workspaceId: string | null): UseFsMutationsResult {
	return useMemo<UseFsMutationsResult>(
		() => ({
			createEntry: async (path, kind) => {
				if (!workspaceId) {
					return { ok: false, error: MISSING_WORKSPACE };
				}
				try {
					return await getRuntimeTrpcClient(workspaceId).workspaceFs.createEntry.mutate({ path, kind });
				} catch (error) {
					return { ok: false, error: errorMessage(error, "Failed to create the entry.") };
				}
			},
			rename: async (path, newName) => {
				if (!workspaceId) {
					return { ok: false, error: MISSING_WORKSPACE };
				}
				try {
					return await getRuntimeTrpcClient(workspaceId).workspaceFs.rename.mutate({ path, newName });
				} catch (error) {
					return { ok: false, error: errorMessage(error, "Failed to rename the entry.") };
				}
			},
			move: async (fromPath, toPath) => {
				if (!workspaceId) {
					return { ok: false, error: MISSING_WORKSPACE };
				}
				try {
					return await getRuntimeTrpcClient(workspaceId).workspaceFs.move.mutate({ fromPath, toPath });
				} catch (error) {
					return { ok: false, error: errorMessage(error, "Failed to move the entry.") };
				}
			},
			deleteEntry: async (path, recursive) => {
				if (!workspaceId) {
					return { ok: false, error: MISSING_WORKSPACE };
				}
				try {
					return await getRuntimeTrpcClient(workspaceId).workspaceFs.deleteEntry.mutate({ path, recursive });
				} catch (error) {
					return { ok: false, error: errorMessage(error, "Failed to delete the entry.") };
				}
			},
		}),
		[workspaceId],
	);
}
