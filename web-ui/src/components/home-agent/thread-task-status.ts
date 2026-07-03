// Presentation metadata for a thread task's board column: the status-dot colour
// and short label the task bar / overflow list show. Colours reuse the board's
// single source of truth (`columnIndicatorColors`) so a chip's dot matches the
// column indicator on the board exactly.

import { columnIndicatorColors } from "@/data/column-colors";
import type { RuntimeBoardColumnId } from "@/runtime/types";

const COLUMN_LABELS: Record<RuntimeBoardColumnId, string> = {
	backlog: "Backlog",
	in_progress: "In progress",
	review: "Review",
	trash: "Done",
};

const FALLBACK_DOT_COLOR = "var(--color-text-tertiary)";

/** Status-dot colour for a board column, matching the board's column indicator. */
export function columnDotColor(columnId: RuntimeBoardColumnId): string {
	return columnIndicatorColors[columnId] ?? FALLBACK_DOT_COLOR;
}

/** Human-readable status label for a board column ("Done" for the terminal bucket). */
export function columnStatusLabel(columnId: RuntimeBoardColumnId): string {
	return COLUMN_LABELS[columnId] ?? columnId;
}

/** Whether a "Start" action applies (only unstarted backlog tasks are startable). */
export function isStartable(columnId: RuntimeBoardColumnId): boolean {
	return columnId === "backlog";
}

/** Whether a "Move to Done" action applies (already-done tasks can't be re-done). */
export function canMoveToDone(columnId: RuntimeBoardColumnId): boolean {
	return columnId !== "trash";
}
