import { useCallback } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeArtifactContentResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseRuntimeArtifactContentResult {
	content: RuntimeArtifactContentResponse | null;
	isLoading: boolean;
	isError: boolean;
}

/**
 * Fetch a single artifact's current content on demand. The file is read live by
 * relative path each time `path` changes (no caching/snapshot), so a renamed or
 * deleted file surfaces as an error rather than stale content.
 */
export function useRuntimeArtifactContent(
	taskId: string | null,
	workspaceId: string | null,
	baseRef: string | null,
	path: string | null,
): UseRuntimeArtifactContentResult {
	const hasScope = taskId !== null && workspaceId !== null && baseRef !== null && path !== null;

	const queryFn = useCallback(async () => {
		if (!taskId || !workspaceId || !baseRef || !path) {
			throw new Error("Missing artifact scope.");
		}
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.getArtifactContent.query({ taskId, baseRef, path });
	}, [baseRef, path, taskId, workspaceId]);

	const contentQuery = useTrpcQuery<RuntimeArtifactContentResponse>({
		enabled: hasScope,
		queryFn,
	});

	return {
		content: contentQuery.data,
		isLoading: contentQuery.isLoading,
		isError: contentQuery.isError,
	};
}
