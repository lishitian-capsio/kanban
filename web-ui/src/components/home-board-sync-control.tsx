import type { ReactElement } from "react";

import { BoardSyncStatusControl } from "@/components/board-sync-status-control";
import { useBoardSync } from "@/hooks/use-board-sync";
import { useRuntimeBoardSyncStatus } from "@/runtime/runtime-stream-store";

/**
 * The top bar's live board-sync badge. Self-contained: it owns its own
 * {@link useBoardSync} and subscribes to the runtime stream's board-sync slice
 * directly, so a ~5s commit/push status broadcast only re-renders this badge —
 * not App, the board, or the chat. Renders nothing until the workspace's board
 * branch is decoupled (the only state the badge surfaces).
 */
export function HomeBoardSyncControl({ workspaceId }: { workspaceId: string | null }): ReactElement | null {
	const liveStatus = useRuntimeBoardSyncStatus();
	const boardSync = useBoardSync(workspaceId, liveStatus);

	if (!boardSync.status?.decoupled) {
		return null;
	}

	return (
		<BoardSyncStatusControl
			status={boardSync.status}
			runningAction={boardSync.runningAction}
			isTogglingPause={boardSync.isTogglingPause}
			onPush={() => {
				void boardSync.push();
			}}
			onPull={() => {
				void boardSync.pull();
			}}
			onTogglePause={() => {
				void boardSync.setPaused(!(boardSync.status?.autoSyncPaused ?? false));
			}}
		/>
	);
}
