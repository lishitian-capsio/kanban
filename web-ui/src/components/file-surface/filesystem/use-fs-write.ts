import { useCallback } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFsWriteFileResponse } from "@/runtime/types";

export interface FsWriteOptions {
	encoding?: "utf8" | "base64";
	/**
	 * The mtime the content was last read at. When set, the backend refuses the
	 * write with `conflict: true` if the file changed on disk (see design §6). Omit
	 * to force an overwrite.
	 */
	expectedMtimeMs?: number;
}

export interface UseFsWriteResult {
	write: (path: string, content: string, options?: FsWriteOptions) => Promise<RuntimeFsWriteFileResponse>;
}

const MISSING_WORKSPACE = "No workspace is selected.";

/**
 * Thin wrapper over `workspaceFs.writeFile`. Resolves to the backend's
 * `{ ok, mtimeMs?, conflict?, error? }` envelope; a transport failure is
 * normalized to the same `{ ok: false, error }` shape so callers only branch on
 * `ok`/`conflict`. Save-state and conflict UX are the caller's responsibility.
 */
export function useFsWrite(workspaceId: string | null): UseFsWriteResult {
	const write = useCallback(
		async (path: string, content: string, options?: FsWriteOptions): Promise<RuntimeFsWriteFileResponse> => {
			if (!workspaceId) {
				return { ok: false, error: MISSING_WORKSPACE };
			}
			try {
				return await getRuntimeTrpcClient(workspaceId).workspaceFs.writeFile.mutate({
					path,
					content,
					encoding: options?.encoding,
					expectedMtimeMs: options?.expectedMtimeMs,
				});
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : "Failed to save the file." };
			}
		},
		[workspaceId],
	);

	return { write };
}
