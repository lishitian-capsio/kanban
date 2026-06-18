import { useCallback, useEffect, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeBoardSyncStatus } from "@/runtime/types";

export type BoardSyncRunningAction = "push" | "pull" | null;

export interface BoardBranchRenameResult {
	ok: boolean;
	archivedTag: string | null;
	error?: string;
}

export interface UseBoardSyncResult {
	/** The current sync status, live ws value preferred over the on-open snapshot; null until loaded. */
	status: RuntimeBoardSyncStatus | null;
	runningAction: BoardSyncRunningAction;
	isTogglingPause: boolean;
	isRenaming: boolean;
	push: () => Promise<void>;
	pull: () => Promise<void>;
	setPaused: (paused: boolean) => Promise<void>;
	renameBranch: (branch: string) => Promise<BoardBranchRenameResult>;
}

/**
 * Owns the workspace's board-branch sync surface: reads the status via
 * `workspace.getBoardSyncStatus` on mount (the ws `board_sync_status_updated`
 * event only fires on later transitions, so the badge needs one initial fetch),
 * preferring the live stream value once it arrives, and drives manual push/pull,
 * the pause toggle, and the rename migration. Idle when no workspace is selected.
 *
 * `liveStatus` is the value carried by the runtime state stream (null until the
 * first broadcast for this workspace); pass it from the App so the badge stays
 * live without polling.
 */
export function useBoardSync(
	workspaceId: string | null,
	liveStatus: RuntimeBoardSyncStatus | null = null,
): UseBoardSyncResult {
	const [snapshotStatus, setSnapshotStatus] = useState<RuntimeBoardSyncStatus | null>(null);
	const [runningAction, setRunningAction] = useState<BoardSyncRunningAction>(null);
	const [isTogglingPause, setIsTogglingPause] = useState(false);
	const [isRenaming, setIsRenaming] = useState(false);

	useEffect(() => {
		if (!workspaceId) {
			setSnapshotStatus(null);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.getBoardSyncStatus.query();
				if (!cancelled) {
					setSnapshotStatus(result.status);
				}
			} catch {
				// Leave the badge hidden until a later status broadcast or retry.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceId]);

	// The live stream value is authoritative once present; fall back to the snapshot.
	const status = liveStatus ?? snapshotStatus;

	const push = useCallback(async () => {
		if (!workspaceId || runningAction) {
			return;
		}
		setRunningAction("push");
		try {
			const result = await getRuntimeTrpcClient(workspaceId).workspace.runBoardSyncAction.mutate({ action: "push" });
			setSnapshotStatus(result.status);
			if (!result.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: result.error ?? "Could not push the board branch.",
					timeout: 7000,
				});
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: `Could not push the board branch. ${error instanceof Error ? error.message : String(error)}`,
				timeout: 7000,
			});
		} finally {
			setRunningAction(null);
		}
	}, [workspaceId, runningAction]);

	const pull = useCallback(async () => {
		if (!workspaceId || runningAction) {
			return;
		}
		setRunningAction("pull");
		try {
			const result = await getRuntimeTrpcClient(workspaceId).workspace.runBoardSyncAction.mutate({ action: "pull" });
			setSnapshotStatus(result.status);
			if (!result.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: result.error ?? "Could not pull the board branch.",
					timeout: 7000,
				});
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: `Could not pull the board branch. ${error instanceof Error ? error.message : String(error)}`,
				timeout: 7000,
			});
		} finally {
			setRunningAction(null);
		}
	}, [workspaceId, runningAction]);

	const setPaused = useCallback(
		async (paused: boolean) => {
			if (!workspaceId || isTogglingPause) {
				return;
			}
			setIsTogglingPause(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.setBoardAutoSync.mutate({ paused });
				setSnapshotStatus(result.status);
			} catch (error) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: `Could not change auto-sync. ${error instanceof Error ? error.message : String(error)}`,
					timeout: 7000,
				});
			} finally {
				setIsTogglingPause(false);
			}
		},
		[workspaceId, isTogglingPause],
	);

	const renameBranch = useCallback(
		async (branch: string): Promise<BoardBranchRenameResult> => {
			if (!workspaceId) {
				return { ok: false, archivedTag: null, error: "No workspace selected." };
			}
			setIsRenaming(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.updateBoardBranch.mutate({ branch });
				setSnapshotStatus(result.status);
				if (!result.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: result.error ?? "Could not rename the board branch.",
						timeout: 8000,
					});
				}
				return { ok: result.ok, archivedTag: result.archivedTag, error: result.error };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: `Could not rename the board branch. ${message}`,
					timeout: 8000,
				});
				return { ok: false, archivedTag: null, error: message };
			} finally {
				setIsRenaming(false);
			}
		},
		[workspaceId],
	);

	return { status, runningAction, isTogglingPause, isRenaming, push, pull, setPaused, renameBranch };
}
