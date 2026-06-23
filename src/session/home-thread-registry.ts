import type {
	RuntimeAgentId,
	RuntimeHomeChatThread,
	RuntimeHomeChatThreadsData,
	RuntimeTaskOrigin,
} from "../core/api-contract";
import { DEFAULT_HOME_THREAD_ID } from "../core/home-agent-session";

/**
 * Pure, I/O-free operations over the persisted home chat thread registry.
 *
 * Each function takes the current {@link RuntimeHomeChatThreadsData} plus
 * parameters and returns a new value without mutating the input. Persistence,
 * locking, and session lifecycle live in the surrounding store
 * (`home-thread-store.ts`).
 */

export interface CreateHomeThreadInput {
	id: string;
	agentId: RuntimeAgentId;
	name: string;
	now: number;
}

/** Return the threads sorted by creation time (oldest first). */
export function listHomeThreads(data: RuntimeHomeChatThreadsData): RuntimeHomeChatThread[] {
	return [...data.threads].sort((a, b) => a.createdAt - b.createdAt);
}

/** Append a new thread. Throws if a thread with the same id already exists. */
export function createHomeThread(
	data: RuntimeHomeChatThreadsData,
	input: CreateHomeThreadInput,
): RuntimeHomeChatThreadsData {
	if (data.threads.some((thread) => thread.id === input.id)) {
		throw new Error(`Home chat thread "${input.id}" already exists.`);
	}
	const thread: RuntimeHomeChatThread = {
		id: input.id,
		agentId: input.agentId,
		name: input.name,
		createdAt: input.now,
		updatedAt: input.now,
	};
	return { threads: [...data.threads, thread] };
}

/** Rename a thread and bump its updatedAt. Throws if the thread is missing. */
export function renameHomeThread(
	data: RuntimeHomeChatThreadsData,
	id: string,
	name: string,
	now: number,
): RuntimeHomeChatThreadsData {
	if (!data.threads.some((thread) => thread.id === id)) {
		throw new Error(`Home chat thread "${id}" not found.`);
	}
	return {
		threads: data.threads.map((thread) => (thread.id === id ? { ...thread, name, updatedAt: now } : thread)),
	};
}

export interface CloseHomeThreadResult {
	next: RuntimeHomeChatThreadsData;
	removed: RuntimeHomeChatThread;
}

export interface DecideAskThreadInput {
	/** The originating home thread recorded on the task, if any. */
	origin: RuntimeTaskOrigin | null | undefined;
	/** The current registry threads (the implicit default thread is never listed). */
	threads: RuntimeHomeChatThread[];
}

/**
 * The target for routing a task's "Ask" review question back to a kanban agent.
 * `existing` carries the agent+thread to derive a home session id from; `create`
 * signals the orchestration layer to open a fresh thread bound to the task.
 */
export type AskThreadDecision = { kind: "existing"; agentId: RuntimeAgentId; threadId: string } | { kind: "create" };

/**
 * Pure decision for where a task's "Ask" should land:
 * - the implicit {@link DEFAULT_HOME_THREAD_ID} resolves directly (it is never
 *   listed in the registry, mirroring its legacy three-segment session id);
 * - a still-registered origin thread resolves to that thread, using the thread's
 *   registered agent as the source of truth;
 * - otherwise (no origin, or the origin thread was closed) we signal `create`, so
 *   the caller opens a fresh thread bound to the task.
 */
export function decideAskThread(input: DecideAskThreadInput): AskThreadDecision {
	const { origin } = input;
	if (!origin) {
		return { kind: "create" };
	}
	if (origin.threadId === DEFAULT_HOME_THREAD_ID) {
		return { kind: "existing", agentId: origin.agentId, threadId: DEFAULT_HOME_THREAD_ID };
	}
	const thread = input.threads.find((candidate) => candidate.id === origin.threadId);
	if (!thread) {
		return { kind: "create" };
	}
	return { kind: "existing", agentId: thread.agentId, threadId: thread.id };
}

/** Remove a thread, returning the new data and the removed entry. Throws if missing. */
export function closeHomeThread(data: RuntimeHomeChatThreadsData, id: string): CloseHomeThreadResult {
	const removed = data.threads.find((thread) => thread.id === id);
	if (!removed) {
		throw new Error(`Home chat thread "${id}" not found.`);
	}
	return {
		next: { threads: data.threads.filter((thread) => thread.id !== id) },
		removed,
	};
}
