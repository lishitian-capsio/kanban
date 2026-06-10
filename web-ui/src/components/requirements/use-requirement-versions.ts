import { useCallback } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeRequirementVersion, RuntimeRequirementVersionsResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

interface UseRequirementVersionsOptions {
	workspaceId: string | null;
	requirementId: string | null;
	/** Bumps after each persisted workspace mutation so freshly-recorded versions are refetched. */
	revision: number;
}

export interface UseRequirementVersionsResult {
	versions: RuntimeRequirementVersion[];
	isLoading: boolean;
	errorMessage: string | null;
}

const EMPTY_VERSIONS: RuntimeRequirementVersion[] = [];

export function useRequirementVersions({
	workspaceId,
	requirementId,
	revision,
}: UseRequirementVersionsOptions): UseRequirementVersionsResult {
	const queryFn = useCallback(async () => {
		if (!workspaceId || !requirementId) {
			throw new Error("Missing workspace or requirement.");
		}
		const trpc = getRuntimeTrpcClient(workspaceId);
		return await trpc.workspace.getRequirementVersions.query({ requirementId });
		// `revision` is intentionally in the dependency list (even though it is not read in the body):
		// changing it re-creates this callback, which re-runs the query so versions recorded by the
		// latest persisted edit show up.
	}, [workspaceId, requirementId, revision]);

	const query = useTrpcQuery<RuntimeRequirementVersionsResponse>({
		enabled: workspaceId !== null && requirementId !== null,
		queryFn,
		retainDataOnError: true,
	});

	return {
		versions: query.data?.versions ?? EMPTY_VERSIONS,
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Could not load version history.") : null,
	};
}
