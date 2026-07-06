/**
 * Board/thread lookups that turn a taskId into an IM delivery route (requirement ac99c).
 *
 * These are the production resolvers the {@link ./im-task-notifier ImTaskEventNotifier} is wired
 * with: a task's `originThreadId` (write-once provenance stamped at creation) points at the home
 * chat thread that spawned it, and that thread's `imChannel` binding is the delivery target. Kept
 * pure (operate on already-loaded data) so the array lookups are unit-testable and the notifier
 * stays decoupled from how the board / threads doc are loaded.
 */
import type { RuntimeBoardData, RuntimeHomeChatThreadsData } from "../core/api-contract";
import type { ImTaskRoute } from "./im-task-notifier";
import type { ImChannelTarget } from "./types";

/**
 * Find a task card by id across all board columns and return its originating thread + title, or
 * `null` when the task is unknown or was not spawned from a home thread (no `originThreadId`).
 */
export function resolveTaskRouteFromBoard(board: RuntimeBoardData, taskId: string): ImTaskRoute | null {
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.id === taskId) {
				if (!card.originThreadId) {
					return null;
				}
				return { originThreadId: card.originThreadId, title: card.title };
			}
		}
	}
	return null;
}

/**
 * Resolve a home thread's bound IM channel from the persisted threads doc, or `null` when the
 * thread is unknown or not bound to any channel.
 */
export function resolveThreadImChannelFromThreads(
	data: RuntimeHomeChatThreadsData,
	threadId: string,
): ImChannelTarget | null {
	const thread = data.threads.find((candidate) => candidate.id === threadId);
	return thread?.imChannel ?? null;
}
