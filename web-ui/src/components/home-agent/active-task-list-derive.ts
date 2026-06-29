// Pure derivation for the fullscreen Task tab's list.
//
// The Task tab is a lean, read-only tracker (NOT a board mirror). It surfaces two
// groups, kept visually distinct so the user never confuses what's running with
// what's merely queued:
//   - Active   — the `in_progress` column (who's running) and the `review` column
//                (who's waiting on me).
//   - Backlog  — the `backlog` column (queued, not yet started).
// done/trash stay hidden. Keeping the selection pure (no React, no store) makes
// the ordering and filtering semantics unit-testable and decoupled from the view.
import type {
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";

/** The active board columns the Task tab surfaces, in display order (running first, awaiting-review second). */
export const ACTIVE_TASK_COLUMN_IDS = ["in_progress", "review"] as const;
/** The queued board columns the Task tab surfaces below the active group. */
export const BACKLOG_TASK_COLUMN_IDS = ["backlog"] as const;

/** Every column id the Task tab can show, across both groups. */
export type TaskTabColumnId =
	| (typeof ACTIVE_TASK_COLUMN_IDS)[number]
	| (typeof BACKLOG_TASK_COLUMN_IDS)[number];

export interface TaskTabEntry {
	taskId: string;
	title: string;
	columnId: TaskTabColumnId;
	/** The task's live session summary, or null when no session has started for it. */
	summary: RuntimeTaskSessionSummary | null;
}

/**
 * Collect the cards from the given board columns, in the column order provided,
 * preserving each column's own rank order, and attach the matching live session
 * summary (or null when no session exists yet for that task).
 */
function collectColumnEntries(
	board: RuntimeBoardData | null | undefined,
	sessions: Record<string, RuntimeTaskSessionSummary> | null | undefined,
	columnIds: readonly TaskTabColumnId[],
): TaskTabEntry[] {
	if (!board) {
		return [];
	}
	const sessionMap = sessions ?? {};
	const entries: TaskTabEntry[] = [];
	for (const columnId of columnIds) {
		const column = board.columns.find((candidate) => candidate.id === columnId);
		if (!column) {
			continue;
		}
		for (const card of column.cards) {
			entries.push({
				taskId: card.id,
				title: card.title,
				columnId,
				summary: sessionMap[card.id] ?? null,
			});
		}
	}
	return entries;
}

/**
 * Select the active (executing) tasks for the Task tab, in display order.
 *
 * Ordering: the `in_progress` column first (the agents currently running), then
 * the `review` column (finished a turn, waiting for the user) — so the list reads
 * "who's running" above "who's waiting on me". Within each column the board's own
 * rank order is preserved. backlog and trash/done are omitted.
 */
export function selectActiveTasks(
	board: RuntimeBoardData | null | undefined,
	sessions: Record<string, RuntimeTaskSessionSummary> | null | undefined,
): TaskTabEntry[] {
	return collectColumnEntries(board, sessions, ACTIVE_TASK_COLUMN_IDS);
}

/**
 * Select the backlog (queued, not yet started) tasks for the Task tab, in the
 * board's rank order. These are shown as a separate, de-emphasized group below
 * the active tasks so the user can see what's waiting to launch.
 */
export function selectBacklogTasks(
	board: RuntimeBoardData | null | undefined,
	sessions: Record<string, RuntimeTaskSessionSummary> | null | undefined,
): TaskTabEntry[] {
	return collectColumnEntries(board, sessions, BACKLOG_TASK_COLUMN_IDS);
}
