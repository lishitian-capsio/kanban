// The tasks a single home chat thread has spawned, for the persistent thread task bar.
//
// Tasks are matched by the `originThreadId` the runtime stamps at creation time (see
// `runtimeBoardCardObjectSchema.originThreadId`) — the same provenance stamp the
// launcher-card counts use (`thread-task-counts.ts`), here expanded from a tally into
// the ordered list the bar renders. Unlike the counts, this INCLUDES the backlog
// column, because the bar surfaces a "Start" action for unstarted tasks.

import { useMemo } from "react";

import { useRuntimeWorkspaceState } from "@/runtime/runtime-stream-store";
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "@/runtime/types";
import type { TaskAutoReviewMode } from "@/types";

export interface HomeThreadTask {
	id: string;
	title: string;
	columnId: RuntimeBoardColumnId;
}

/** Quick-actions a thread task bar / list row can drive. Wired to the same board
 *  handlers the kanban board uses, so behaviour matches column drags exactly. */
export interface HomeThreadTaskActions {
	/** Start a backlog task (moves it to In progress and launches its session). */
	onStartTask: (taskId: string) => void;
	/** Move a task to the terminal Done column (done/trash are one bucket). */
	onMoveTaskToDone: (taskId: string) => void;
	/** Permanently remove a task from the board and clean up its workspace. */
	onDeleteTask: (taskId: string) => void;
	/** Open the task's detail view. */
	onOpenTask: (taskId: string) => void;
}

/**
 * The richer action set the "Session tasks" dialog drives, on top of the minimal
 * bar/chip set. Kept separate so the bar and chip (which only need the four base
 * actions) don't type against members they never use.
 */
export interface SessionTaskDialogActions extends HomeThreadTaskActions {
	/** Restore a done/trashed task back to the Review column. */
	onRestoreTask: (taskId: string) => void;
	/** Link two thread tasks (the handler enforces the backlog↔non-backlog gate). */
	onCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	/** Remove a dependency edge by its id. */
	onDeleteDependency: (dependencyId: string) => void;
	/** Enable/disable a task's automatic review and pick its mode (commit / PR). */
	onSetAutoReview: (taskId: string, enabled: boolean, mode: TaskAutoReviewMode) => void;
}

/**
 * Collect a thread's tasks in board order (columns top-to-bottom, cards in rank
 * order), matched by `originThreadId === threadId`. Pure: returns `[]` for a null
 * board or blank thread id. Includes every column so the bar can show a Start
 * action for backlog tasks and a Done marker for finished ones.
 */
export function collectThreadTasks(
	board: RuntimeBoardData | null | undefined,
	threadId: string | null | undefined,
): HomeThreadTask[] {
	const normalizedThreadId = threadId?.trim() ?? "";
	if (!board || !normalizedThreadId) {
		return [];
	}
	const tasks: HomeThreadTask[] = [];
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.originThreadId === normalizedThreadId) {
				tasks.push({ id: card.id, title: card.title, columnId: column.id });
			}
		}
	}
	return tasks;
}

/**
 * Leaf-subscribed task list for a single thread. Reads the board off the
 * workspace-state slice and derives the list memoized on the board reference.
 * Per the runtime store's leaf-subscription rule, call this inside the bar
 * component, never at App level.
 */
export function useHomeThreadTasks(threadId: string | null): HomeThreadTask[] {
	const workspaceState = useRuntimeWorkspaceState();
	const board = workspaceState?.board ?? null;
	return useMemo(() => collectThreadTasks(board, threadId), [board, threadId]);
}

/**
 * Like {@link collectThreadTasks}, but returns the FULL cards (with the column id
 * attached) rather than the minimal `{id,title,columnId}` shape. The dialog needs
 * the rich card (agent, auto-review, etc.) and the board column each card sits in;
 * the bar keeps the minimal collector so its chip-measuring layer is untouched.
 */
export interface ThreadTaskCard {
	card: RuntimeBoardCard;
	columnId: RuntimeBoardColumnId;
}

export function collectThreadTaskCards(
	board: RuntimeBoardData | null | undefined,
	threadId: string | null | undefined,
): ThreadTaskCard[] {
	const normalizedThreadId = threadId?.trim() ?? "";
	if (!board || !normalizedThreadId) {
		return [];
	}
	const cards: ThreadTaskCard[] = [];
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.originThreadId === normalizedThreadId) {
				cards.push({ card, columnId: column.id });
			}
		}
	}
	return cards;
}

/** Leaf-subscribed rich card list for a single thread (dialog-only). */
export function useHomeThreadTaskCards(threadId: string | null): ThreadTaskCard[] {
	const workspaceState = useRuntimeWorkspaceState();
	const board = workspaceState?.board ?? null;
	return useMemo(() => collectThreadTaskCards(board, threadId), [board, threadId]);
}
