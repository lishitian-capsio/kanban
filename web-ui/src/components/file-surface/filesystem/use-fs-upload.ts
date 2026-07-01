import { useCallback, useMemo, useState } from "react";

import { readFileAsUploadPayload } from "@/components/files/file-upload-utils";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFsEntry } from "@/runtime/types";

/** Same-name policy mirrored from the backend `workspaceFs.uploadFile` contract. */
export type FsUploadConflictMode = "error" | "overwrite" | "rename";

/** One entry that could not be uploaded, paired with a human-readable reason. */
export interface FsUploadFailure {
	name: string;
	error: string;
}

/**
 * Outcome of uploading a batch of files into one directory:
 * - `succeeded`: written entries (final names; a "rename" may differ from input),
 * - `conflicts`: the original {@link File}s that hit an existing name in `"error"`
 *   mode (nothing written for them — the caller confirms overwrite / keep-both),
 * - `failed`: files that errored for any other reason (too large, transport, …).
 */
export interface FsUploadResult {
	succeeded: RuntimeFsEntry[];
	conflicts: File[];
	failed: FsUploadFailure[];
}

export interface UseFsUploadResult {
	/** True while a batch is being read + written (buttons/menu items can disable). */
	isUploading: boolean;
	/**
	 * Upload each file's bytes into `dir` ("" = repo root) sequentially. `mode`
	 * decides same-name behavior (default "error" surfaces conflicts for the caller
	 * to confirm). Reads each file to base64 in the browser, then calls the backend.
	 */
	uploadFiles: (dir: string, files: File[], mode?: FsUploadConflictMode) => Promise<FsUploadResult>;
}

/**
 * Upload OS files into the working tree via `workspaceFs.uploadFile`. Kept as its
 * own hook (separate from the create/rename/move/delete mutations) because upload
 * carries a byte payload and a conflict protocol the others don't. Toasting +
 * incremental tree refresh are the caller's responsibility.
 */
export function useFsUpload(workspaceId: string | null): UseFsUploadResult {
	const [isUploading, setIsUploading] = useState(false);

	const uploadFiles = useCallback(
		async (dir: string, files: File[], mode: FsUploadConflictMode = "error"): Promise<FsUploadResult> => {
			const result: FsUploadResult = { succeeded: [], conflicts: [], failed: [] };
			if (!workspaceId || files.length === 0) {
				return result;
			}
			setIsUploading(true);
			try {
				const client = getRuntimeTrpcClient(workspaceId);
				// Sequential: a "rename" pass must see prior writes so it never picks a
				// name a still-in-flight sibling is about to take.
				for (const file of files) {
					const payload = await readFileAsUploadPayload(file);
					if (!payload) {
						result.failed.push({ name: file.name || "untitled", error: "The file is too large or could not be read." });
						continue;
					}
					try {
						const response = await client.workspaceFs.uploadFile.mutate({
							dir,
							name: payload.name,
							data: payload.data,
							onConflict: mode,
						});
						if (response.ok && response.entry) {
							result.succeeded.push(response.entry);
						} else if (response.conflict) {
							result.conflicts.push(file);
						} else {
							result.failed.push({ name: payload.name, error: response.error ?? "Failed to upload the file." });
						}
					} catch (error) {
						result.failed.push({
							name: payload.name,
							error: error instanceof Error ? error.message : "Failed to upload the file.",
						});
					}
				}
				return result;
			} finally {
				setIsUploading(false);
			}
		},
		[workspaceId],
	);

	return useMemo(() => ({ isUploading, uploadFiles }), [isUploading, uploadFiles]);
}
