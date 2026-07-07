/**
 * Board/thread lookups that turn a taskId into an IM delivery route (requirement ac99c).
 *
 * These are the production resolvers the {@link ./im-task-notifier ImTaskEventNotifier} is wired
 * with: a task's `originThreadId` (write-once provenance stamped at creation) points at the home
 * chat thread that spawned it, and that thread's `imChannel` binding is the delivery target. Kept
 * pure (operate on already-loaded data) so the array lookups are unit-testable and the notifier
 * stays decoupled from how the board / threads doc are loaded.
 */
import type { RuntimeAgentId, RuntimeBoardData, RuntimeHomeChatThreadsData } from "../core/api-contract";
import { DEFAULT_HOME_THREAD_ID } from "../core/home-agent-session";
import type { ImTaskRoute } from "./im-task-notifier";
import type { ImChannelTarget, ImPlatform } from "./types";

/**
 * The Pi single conversation (decision X1) is not a home thread; its IM binding lives at the doc
 * level (`piImChannel`). When it is the delivery target, inbound routing addresses it as Pi's
 * implicit default session — agent `pi`, thread {@link DEFAULT_HOME_THREAD_ID} — which the runtime
 * turns into the stable 3-segment Pi home session id.
 */
const PI_AGENT_ID: RuntimeAgentId = "pi";

/** The home thread an inbound IM chat is routed to: which thread, and the agent that backs it. */
export interface ImThreadBinding {
	threadId: string;
	agentId: RuntimeAgentId;
}

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

/**
 * Resolve the IM channel a home session's reply should be pushed back to, dispatching on the agent
 * (requirement ac99c). Pi's binding is the doc-level `piImChannel` (decision X1), not a thread, so
 * a Pi reply resolves there; any other agent resolves its thread's `imChannel` by `threadId`. This
 * split matters for the reply notifier: passing agent through prevents a browser-driven CLI default
 * session (which parses to `threadId === "default"` but has no binding) from mis-routing to Pi's
 * channel. Returns `null` when nothing is bound.
 */
export function resolveHomeSessionImChannel(
	data: RuntimeHomeChatThreadsData,
	agentId: string,
	threadId: string,
): ImChannelTarget | null {
	if (agentId === PI_AGENT_ID) {
		return data.piImChannel ?? null;
	}
	return resolveThreadImChannelFromThreads(data, threadId);
}

/**
 * The inverse of {@link resolveThreadImChannelFromThreads}: find the home thread a given
 * inbound IM chat is bound to (an `imChannel` matching `platform` + `chatId`), returning the
 * thread id and the agent that backs it, or `null` when no thread is bound to that chat.
 *
 * Binding is a deliberate one-to-one user action (requirement ac99c), so the first match wins;
 * a defensive `find` still tolerates an accidental duplicate binding by picking the first.
 */
export function findThreadBoundToImChannel(
	data: RuntimeHomeChatThreadsData,
	platform: ImPlatform,
	chatId: string,
): ImThreadBinding | null {
	const thread = data.threads.find(
		(candidate) => candidate.imChannel?.platform === platform && candidate.imChannel.chatId === chatId,
	);
	if (thread) {
		return { threadId: thread.id, agentId: thread.agentId };
	}
	// The Pi single conversation (decision X1) is bound at the doc level, not on a thread — so
	// check it too. The one-to-one invariant (bind helpers) keeps a channel from being on both a
	// thread and Pi at once, so this only fires when no thread matched.
	if (data.piImChannel?.platform === platform && data.piImChannel.chatId === chatId) {
		return { threadId: DEFAULT_HOME_THREAD_ID, agentId: PI_AGENT_ID };
	}
	return null;
}
