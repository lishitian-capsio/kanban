// Pure derivation for the fullscreen Task tab's active-task list.
//
// The Task tab is a lean, read-only tracker (NOT a board mirror): it lists only
// the tasks that are actively executing — the `in_progress` column (who's
// running) and the `review` column (who's waiting on me) — so the user sees
// execution status at a glance instead of polling the CLI. backlog / done are
// hidden. Keeping the selection pure (no React, no store) makes the ordering and
// filtering semantics unit-testable and decoupled from the view.
import type {
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";

/** The board columns the Task tab surfaces, in display order (running first, awaiting-review second). */
export const ACTIVE_TASK_COLUMN_IDS = ["in_progress", "review"] as const;
export type ActiveTaskColumnId = (typeof ACTIVE_TASK_COLUMN_IDS)[number];

export interface ActiveTaskEntry {
	taskId: string;
	title: string;
	columnId: ActiveTaskColumnId;
	/** The task's live session summary, or null when no session has started for it. */
	summary: RuntimeTaskSessionSummary | null;
}

/**
 * Select the active tasks to show in the Task tab, in display order.
 *
 * Ordering: the `in_progress` column first (the agents currently running), then
 * the `review` column (finished a turn, waiting for the user) — so the list reads
 * "who's running" above "who's waiting on me". Within each column the board's own
 * rank order is preserved. Tasks in any other column (backlog / trash/done) are
 * omitted entirely.
 */
export function selectActiveTasks(
	board: RuntimeBoardData | null | undefined,
	sessions: Record<string, RuntimeTaskSessionSummary> | null | undefined,
): ActiveTaskEntry[] {
	if (!board) {
		return [];
	}
	const sessionMap = sessions ?? {};
	const entries: ActiveTaskEntry[] = [];
	for (const columnId of ACTIVE_TASK_COLUMN_IDS) {
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
