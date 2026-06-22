import { useCallback, useEffect, useRef } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeArtifactsResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseRuntimeWorkspaceArtifactsResult {
	artifacts: RuntimeArtifactsResponse | null;
	isLoading: boolean;
	isRuntimeAvailable: boolean;
	refresh: () => Promise<void>;
}

/**
 * Read-only artifact list for a task, recomputed from the worktree on every
 * fetch. Mirrors the diff hook's cadence: it refetches when the task workspace
 * state version changes and polls while the panel is visible, so artifacts
 * produced during a running task appear in near real time.
 */
export function useRuntimeWorkspaceArtifacts(
	taskId: string | null,
	workspaceId: string | null,
	baseRef: string | null,
	stateVersion = 0,
	pollIntervalMs: number | null = null,
	enabled = true,
): UseRuntimeWorkspaceArtifactsResult {
	const hasWorkspaceScope = enabled && taskId !== null && workspaceId !== null && baseRef !== null;
	const requestKey = `${workspaceId ?? "__none__"}:${taskId ?? "__none__"}:${baseRef ?? "__none__"}`;
	const previousRequestKeyRef = useRef(requestKey);
	const isRequestTransitioning = hasWorkspaceScope && previousRequestKeyRef.current !== requestKey;

	const queryFn = useCallback(async () => {
		if (!taskId || !workspaceId || !baseRef) {
			throw new Error("Missing workspace scope.");
		}
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.getArtifacts.query({ taskId, baseRef });
	}, [baseRef, taskId, workspaceId]);

	const artifactsQuery = useTrpcQuery<RuntimeArtifactsResponse>({
		enabled: hasWorkspaceScope,
		queryFn,
	});

	const refresh = useCallback(async () => {
		if (!hasWorkspaceScope) {
			return;
		}
		await artifactsQuery.refetch();
	}, [artifactsQuery.refetch, hasWorkspaceScope]);

	const previousStateVersionRef = useRef(stateVersion);

	// Clear stale artifacts immediately when switching to a different task.
	useEffect(() => {
		if (!isRequestTransitioning) {
			return;
		}
		previousRequestKeyRef.current = requestKey;
		artifactsQuery.setData(null);
	}, [artifactsQuery.setData, isRequestTransitioning, requestKey]);

	useEffect(() => {
		if (!hasWorkspaceScope) {
			previousRequestKeyRef.current = requestKey;
			previousStateVersionRef.current = stateVersion;
			return;
		}
		if (previousStateVersionRef.current === stateVersion) {
			return;
		}
		previousStateVersionRef.current = stateVersion;
		void artifactsQuery.refetch();
	}, [artifactsQuery.refetch, hasWorkspaceScope, requestKey, stateVersion]);

	useEffect(() => {
		if (!hasWorkspaceScope || pollIntervalMs == null) {
			return;
		}
		const interval = window.setInterval(() => {
			void artifactsQuery.refetch();
		}, pollIntervalMs);
		return () => {
			window.clearInterval(interval);
		};
	}, [artifactsQuery.refetch, hasWorkspaceScope, pollIntervalMs]);

	if (!taskId || !workspaceId || !baseRef) {
		return {
			artifacts: null,
			isLoading: false,
			isRuntimeAvailable: workspaceId !== null,
			refresh,
		};
	}

	const shouldHideDuringTransition = isRequestTransitioning;
	return {
		artifacts: shouldHideDuringTransition ? null : artifactsQuery.data,
		isLoading: shouldHideDuringTransition || artifactsQuery.isLoading,
		isRuntimeAvailable: shouldHideDuringTransition ? true : !artifactsQuery.isError,
		refresh,
	};
}
