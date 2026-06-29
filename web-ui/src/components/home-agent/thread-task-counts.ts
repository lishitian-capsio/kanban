// Per-thread task status counts for the fullscreen Home-tab launcher cards.
//
// Each launcher card is one home chat thread; this groups the board's tasks by
// the `originThreadId` the runtime stamps when an agent creates a task from a
// thread (see `runtimeBoardCardObjectSchema.originThreadId`) and counts the three
// active buckets the card surfaces: in progress, awaiting review, and done.
//
// `done` maps to the terminal `trash` column — Kanban's board uses one terminal
// bucket whose column is titled "Done" (src/state/task-shard-store.ts). The
// `backlog` column is intentionally excluded: the card reports work the thread has
// actually set in motion, not unstarted ideas.

import { useMemo } from "react";

import { useRuntimeWorkspaceState } from "@/runtime/runtime-stream-store";
import type { RuntimeBoardColumnId, RuntimeBoardData } from "@/runtime/types";

export interface HomeThreadTaskCounts {
	inProgress: number;
	review: number;
	done: number;
	/** Sum of the three buckets above — `0` means the thread has no active tasks. */
	total: number;
}

const EMPTY_COUNTS: HomeThreadTaskCounts = { inProgress: 0, review: 0, done: 0, total: 0 };

// Which board column each surfaced bucket reads from. `trash` is the terminal
// "Done" column (done/trash are the same bucket on this board).
const COLUMN_BUCKET: Partial<Record<RuntimeBoardColumnId, keyof Omit<HomeThreadTaskCounts, "total">>> = {
	in_progress: "inProgress",
	review: "review",
	trash: "done",
};

/**
 * Count a thread's tasks per active status. Pure: matches cards by
 * `originThreadId === threadId` and tallies the in-progress / review / done
 * columns. Returns all-zero counts for a null board or an empty/blank thread id.
 */
export function countThreadTasksByStatus(
	board: RuntimeBoardData | null | undefined,
	threadId: string,
): HomeThreadTaskCounts {
	const normalizedThreadId = threadId.trim();
	if (!board || !normalizedThreadId) {
		return { ...EMPTY_COUNTS };
	}
	const counts: HomeThreadTaskCounts = { ...EMPTY_COUNTS };
	for (const column of board.columns) {
		const bucket = COLUMN_BUCKET[column.id];
		if (!bucket) {
			continue;
		}
		for (const card of column.cards) {
			if (card.originThreadId === normalizedThreadId) {
				counts[bucket] += 1;
				counts.total += 1;
			}
		}
	}
	return counts;
}

/**
 * Leaf-subscribed task counts for a single thread. Reads the board off the
 * workspace-state slice and derives the counts memoized on the board reference,
 * so a card only recomputes when the board actually changes. Per the runtime
 * store's leaf-subscription rule, call this inside the launcher card component,
 * never at App level.
 */
export function useHomeThreadTaskCounts(threadId: string): HomeThreadTaskCounts {
	const workspaceState = useRuntimeWorkspaceState();
	const board = workspaceState?.board ?? null;
	return useMemo(() => countThreadTasksByStatus(board, threadId), [board, threadId]);
}
