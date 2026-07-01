import { useCallback } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFsReadFileResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseFsFileResult {
	data: RuntimeFsReadFileResponse | null;
	isLoading: boolean;
	errorMessage: string | null;
	refetch: () => Promise<RuntimeFsReadFileResponse | null>;
}

/**
 * Fetch a single working-tree file via `workspaceFs.readFile`. Enabled only when
 * a workspace + path are set; the backend decides text-vs-binary and enforces the
 * size cap (`tooLarge`), so this hook just surfaces the response verbatim.
 */
export function useFsFile(workspaceId: string | null, path: string | null): UseFsFileResult {
	const isEnabled = workspaceId !== null && path !== null && path.length > 0;

	const queryFn = useCallback(async () => {
		if (!workspaceId || !path) {
			throw new Error("Missing file.");
		}
		return await getRuntimeTrpcClient(workspaceId).workspaceFs.readFile.query({ path });
	}, [workspaceId, path]);

	const query = useTrpcQuery({ enabled: isEnabled, queryFn, retainDataOnError: false });

	return {
		data: query.data,
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Could not read file.") : null,
		refetch: query.refetch,
	};
}
