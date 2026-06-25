import type {
	RuntimeAgentId,
	RuntimeHomeChatThread,
	RuntimeHomeChatThreadsData,
	RuntimeHomeChatThreadTitleSource,
} from "../core/api-contract";

/**
 * Pure, I/O-free operations over the persisted home chat thread registry.
 *
 * Each function takes the current {@link RuntimeHomeChatThreadsData} plus
 * parameters and returns a new value without mutating the input. Persistence,
 * locking, and session lifecycle live in the surrounding store
 * (`home-thread-store.ts`).
 */

/** Max length of a provisional title derived from a kickoff description. */
const PROVISIONAL_TITLE_MAX_LENGTH = 60;

export interface CreateHomeThreadInput {
	id: string;
	agentId: RuntimeAgentId;
	name: string;
	/** How `name` was set. Defaults to `manual` (pinned) when omitted. */
	titleSource?: RuntimeHomeChatThreadTitleSource;
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
		titleSource: input.titleSource ?? "manual",
		createdAt: input.now,
		updatedAt: input.now,
	};
	return { threads: [...data.threads, thread] };
}

/**
 * Rename a thread and bump its updatedAt — the USER-driven path. This PINS the title:
 * the new name is recorded as `manual`, after which the thread's own agent must not
 * overwrite it via {@link setHomeThreadAutoTitle}. Throws if the thread is missing.
 */
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
		threads: data.threads.map((thread) =>
			thread.id === id ? { ...thread, name, titleSource: "manual", updatedAt: now } : thread,
		),
	};
}

export interface SetHomeThreadAutoTitleResult {
	next: RuntimeHomeChatThreadsData;
	/** False when the title was pinned `manual` and therefore left untouched. */
	applied: boolean;
	/** The thread after the operation (unchanged when `applied` is false). */
	thread: RuntimeHomeChatThread;
}

/**
 * Set a thread's title from its own agent (`home-thread set-title`). Writes
 * `titleSource="auto"` and bumps updatedAt, but ONLY when the current title is not
 * pinned `manual`: a user rename always wins, so a manually-titled thread is left
 * untouched (`applied: false`). Throws if the thread is missing.
 */
export function setHomeThreadAutoTitle(
	data: RuntimeHomeChatThreadsData,
	id: string,
	title: string,
	now: number,
): SetHomeThreadAutoTitleResult {
	const existing = data.threads.find((thread) => thread.id === id);
	if (!existing) {
		throw new Error(`Home chat thread "${id}" not found.`);
	}
	if (existing.titleSource === "manual") {
		return { next: data, applied: false, thread: existing };
	}
	const updated: RuntimeHomeChatThread = { ...existing, name: title, titleSource: "auto", updatedAt: now };
	return {
		next: { threads: data.threads.map((thread) => (thread.id === id ? updated : thread)) },
		applied: true,
		thread: updated,
	};
}

/**
 * Derive a provisional `auto` title from a thread's kickoff description: the first
 * non-empty line, whitespace-collapsed and truncated to {@link PROVISIONAL_TITLE_MAX_LENGTH}
 * (with an ellipsis). The agent replaces this with a concise summary shortly after its
 * first turn; this is only the placeholder shown until then. Pure and side-effect-free.
 */
export function deriveProvisionalThreadTitle(description: string): string {
	const firstLine = description.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
	const collapsed = firstLine.replace(/\s+/g, " ").trim();
	if (collapsed.length <= PROVISIONAL_TITLE_MAX_LENGTH) {
		return collapsed;
	}
	return `${collapsed.slice(0, PROVISIONAL_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
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
