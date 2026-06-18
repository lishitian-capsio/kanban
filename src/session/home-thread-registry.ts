import type { RuntimeAgentId, RuntimeHomeChatThread, RuntimeHomeChatThreadsData } from "../core/api-contract";

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
		takeoverEnabled: false,
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

export interface SetHomeThreadTakeoverInput {
	enabled: boolean;
	// undefined → keep the current extension; null → clear it; string → set it.
	extension?: string | null;
}

/**
 * Set a thread's agent-takeover switch (and optionally its extension reference),
 * bumping updatedAt. Throws if the thread is missing. Pure — persistence lives in
 * the surrounding store.
 */
export function setHomeThreadTakeover(
	data: RuntimeHomeChatThreadsData,
	id: string,
	input: SetHomeThreadTakeoverInput,
	now: number,
): RuntimeHomeChatThreadsData {
	if (!data.threads.some((thread) => thread.id === id)) {
		throw new Error(`Home chat thread "${id}" not found.`);
	}
	return {
		threads: data.threads.map((thread) => {
			if (thread.id !== id) {
				return thread;
			}
			const next: RuntimeHomeChatThread = { ...thread, takeoverEnabled: input.enabled, updatedAt: now };
			if (input.extension === null) {
				delete next.takeoverExtension;
			} else if (input.extension !== undefined) {
				next.takeoverExtension = input.extension;
			}
			return next;
		}),
	};
}

export interface CloseHomeThreadResult {
	next: RuntimeHomeChatThreadsData;
	removed: RuntimeHomeChatThread;
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
