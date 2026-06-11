import { useCallback, useMemo } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseFileBytesResult {
	/** A `data:` URL ready for an <img>/<audio>/<video> src, or null when unavailable. */
	dataUrl: string | null;
	isLoading: boolean;
	errorMessage: string | null;
}

/**
 * Lazily fetch a file's bytes via `workspace.getFileBytes` and expose them as a `data:` URL.
 * Pass `enabled: false` to skip the fetch entirely (e.g. for non-previewable categories or
 * oversized files where we prefer a placeholder icon).
 */
export function useFileBytes(workspaceId: string | null, fileId: string | null, enabled: boolean): UseFileBytesResult {
	const isEnabled = enabled && workspaceId !== null && fileId !== null;

	const queryFn = useCallback(async () => {
		if (!workspaceId || !fileId) {
			throw new Error("Missing file.");
		}
		return await getRuntimeTrpcClient(workspaceId).workspace.getFileBytes.query({ id: fileId });
	}, [workspaceId, fileId]);

	const query = useTrpcQuery({ enabled: isEnabled, queryFn, retainDataOnError: true });

	const dataUrl = useMemo(() => {
		const result = query.data;
		if (!result?.data || !result.mimeType) {
			return null;
		}
		return `data:${result.mimeType};base64,${result.data}`;
	}, [query.data]);

	return {
		dataUrl,
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Could not load file.") : null,
	};
}
