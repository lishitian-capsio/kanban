import type {
	RuntimeAgentId,
	RuntimeHomeChatFullscreenTabs,
	RuntimeHomeChatThread,
	RuntimeHomeChatThreadsData,
	RuntimeHomeChatThreadTitleSource,
} from "../core/api-contract";
import { DEFAULT_HOME_THREAD_ID } from "../core/home-agent-session";
import type { ImChannelTarget } from "../im/types";

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
	// Spread `data` so the persisted fullscreen tab set survives — dropping it here
	// collapsed every open session tab back to Home on the next registry refresh.
	return { ...data, threads: [...data.threads, thread] };
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
		...data,
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
		next: { ...data, threads: data.threads.map((thread) => (thread.id === id ? updated : thread)) },
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

/**
 * Set (or clear) a thread's transient `pendingNextStep` suggestion. Passing `null` clears it.
 * This is ephemeral state — it does NOT bump `updatedAt` (which tracks title/identity changes)
 * and never reorders the list. Returns the SAME data reference when the value is unchanged
 * (treating an absent field and `null` as equivalent), so the runtime's clear-on-every-send
 * does not rewrite `threads.json` when there is nothing to clear. Throws if the thread is missing.
 */
export function setHomeThreadNextStep(
	data: RuntimeHomeChatThreadsData,
	id: string,
	suggestion: string | null,
): RuntimeHomeChatThreadsData {
	const existing = data.threads.find((thread) => thread.id === id);
	if (!existing) {
		throw new Error(`Home chat thread "${id}" not found.`);
	}
	const next = suggestion ?? null;
	if ((existing.pendingNextStep ?? null) === next) {
		return data;
	}
	return {
		...data,
		threads: data.threads.map((thread) => (thread.id === id ? { ...thread, pendingNextStep: next } : thread)),
	};
}

function imChannelsEqual(a: ImChannelTarget | null, b: ImChannelTarget | null): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	return a.platform === b.platform && a.chatId === b.chatId;
}

/**
 * Bind a thread to an IM channel, or unbind it when `channel` is `null` (requirement ac99c).
 * Bumps `updatedAt` on a real change. Returns the SAME data reference when the binding is
 * unchanged (treating an absent field and `null` as equivalent), so an unbind on an already-
 * unbound thread does not rewrite `threads.json`. Throws if the thread is missing.
 */
export function setHomeThreadImChannel(
	data: RuntimeHomeChatThreadsData,
	id: string,
	channel: ImChannelTarget | null,
	now: number,
): RuntimeHomeChatThreadsData {
	const existing = data.threads.find((thread) => thread.id === id);
	if (!existing) {
		throw new Error(`Home chat thread "${id}" not found.`);
	}
	const next = channel ?? null;
	if (imChannelsEqual(existing.imChannel ?? null, next)) {
		return data;
	}
	return {
		...data,
		threads: data.threads.map((thread) =>
			thread.id === id ? { ...thread, imChannel: next, updatedAt: now } : thread,
		),
	};
}

export interface CloseHomeThreadResult {
	next: RuntimeHomeChatThreadsData;
	removed: RuntimeHomeChatThread;
}

/**
 * Remove a thread, returning the new data and the removed entry. Also prunes the
 * removed thread from the persisted fullscreen tab set so a hard-closed thread can
 * never linger as a stale open tab. Throws if missing.
 */
export function closeHomeThread(data: RuntimeHomeChatThreadsData, id: string): CloseHomeThreadResult {
	const removed = data.threads.find((thread) => thread.id === id);
	if (!removed) {
		throw new Error(`Home chat thread "${id}" not found.`);
	}
	const threads = data.threads.filter((thread) => thread.id !== id);
	const next: RuntimeHomeChatThreadsData = { threads };
	if (data.fullscreenTabs) {
		next.fullscreenTabs = sanitizeFullscreenTabs(data.fullscreenTabs, threads.map((thread) => thread.id));
	}
	return { next, removed };
}

// ---------------------------------------------------------------------------
// Fullscreen workspace tab set (decision 1902b)
//
// Pure view state persisted on the registry doc: which threads are open as
// session tabs and which tab is active. The synthetic default thread is always a
// valid tab target even though it is not a registry entry.
// ---------------------------------------------------------------------------

const EMPTY_FULLSCREEN_TABS: RuntimeHomeChatFullscreenTabs = { openThreadIds: [], activeThreadId: null };

/** The persisted fullscreen tab set, or an empty Home-active set when none is stored. */
export function getHomeFullscreenTabs(data: RuntimeHomeChatThreadsData): RuntimeHomeChatFullscreenTabs {
	return data.fullscreenTabs ?? EMPTY_FULLSCREEN_TABS;
}

/**
 * Drop open tab ids that are not real threads (deduping, preserving order) and clear
 * the active id when it is not among the surviving open tabs. The synthetic default
 * thread is always treated as valid. Pure and side-effect free.
 */
export function sanitizeFullscreenTabs(
	tabs: RuntimeHomeChatFullscreenTabs,
	threadIds: readonly string[],
): RuntimeHomeChatFullscreenTabs {
	const valid = new Set<string>([DEFAULT_HOME_THREAD_ID, ...threadIds]);
	const seen = new Set<string>();
	const openThreadIds: string[] = [];
	for (const id of tabs.openThreadIds) {
		if (valid.has(id) && !seen.has(id)) {
			seen.add(id);
			openThreadIds.push(id);
		}
	}
	const activeThreadId =
		tabs.activeThreadId !== null && seen.has(tabs.activeThreadId) ? tabs.activeThreadId : null;
	return { openThreadIds, activeThreadId };
}

function fullscreenTabsEqual(a: RuntimeHomeChatFullscreenTabs, b: RuntimeHomeChatFullscreenTabs): boolean {
	return (
		a.activeThreadId === b.activeThreadId &&
		a.openThreadIds.length === b.openThreadIds.length &&
		a.openThreadIds.every((id, index) => id === b.openThreadIds[index])
	);
}

/**
 * Persist a new fullscreen tab set, sanitized against the current threads. Returns the
 * SAME data reference when the sanitized set is unchanged (so the runtime does not
 * rewrite `threads.json` on a no-op). Leaves the threads list untouched.
 */
export function setHomeFullscreenTabs(
	data: RuntimeHomeChatThreadsData,
	tabs: RuntimeHomeChatFullscreenTabs,
): RuntimeHomeChatThreadsData {
	const sanitized = sanitizeFullscreenTabs(tabs, data.threads.map((thread) => thread.id));
	if (data.fullscreenTabs && fullscreenTabsEqual(data.fullscreenTabs, sanitized)) {
		return data;
	}
	return { threads: data.threads, fullscreenTabs: sanitized };
}
