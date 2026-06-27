// Pure state model for the fullscreen Home-tab/session-tab workspace (decision 1902b).
//
// The fullscreen layout shows a permanent Home tab (the session-card launcher) plus a
// strip of coexisting session tabs, one per opened thread. This module owns the open-tab
// set + active-tab transitions; persistence (to the thread registry) and rendering live
// in `use-home-threads` and the workspace components. `activeThreadId === null` means the
// Home tab is active; otherwise it is the active session tab's thread id.
//
// The shape mirrors the persisted `RuntimeHomeChatFullscreenTabs`, so the same value flows
// straight to/from the registry with no translation.
import type { RuntimeHomeChatFullscreenTabs } from "@/runtime/types";

export type FullscreenTabsState = RuntimeHomeChatFullscreenTabs;

// Soft cap on simultaneously open session tabs. Opening past it evicts the oldest open tab
// (a UI-only collapse-back-to-Home — the thread/session is untouched). The strip also scrolls
// horizontally, so the cap only bounds clutter rather than hiding reachable conversations.
export const MAX_OPEN_SESSION_TABS = 8;

const EMPTY: FullscreenTabsState = { openThreadIds: [], activeThreadId: null };

/**
 * Open a session tab for `threadId` and make it active. An already-open tab is just
 * activated (no reorder, no duplicate). Opening beyond `maxTabs` evicts the oldest open
 * tab. The opened tab is always the active tab afterwards.
 */
export function openSessionTab(
	state: FullscreenTabsState,
	threadId: string,
	maxTabs: number = MAX_OPEN_SESSION_TABS,
): FullscreenTabsState {
	if (state.openThreadIds.includes(threadId)) {
		return state.activeThreadId === threadId ? state : { ...state, activeThreadId: threadId };
	}
	let openThreadIds = [...state.openThreadIds, threadId];
	if (openThreadIds.length > maxTabs) {
		openThreadIds = openThreadIds.slice(openThreadIds.length - maxTabs);
	}
	return { openThreadIds, activeThreadId: threadId };
}

/**
 * Close a session tab (collapse back to Home — UI only, never a thread hard-close). When the
 * closed tab was active, the tab that shifts into its slot becomes active (or the Home tab
 * when none remains). Closing a non-active tab leaves the active tab in place. Returns the
 * same state when the tab is not open.
 */
export function closeSessionTab(state: FullscreenTabsState, threadId: string): FullscreenTabsState {
	const index = state.openThreadIds.indexOf(threadId);
	if (index === -1) {
		return state;
	}
	const openThreadIds = state.openThreadIds.filter((id) => id !== threadId);
	if (state.activeThreadId !== threadId) {
		return { openThreadIds, activeThreadId: state.activeThreadId };
	}
	if (openThreadIds.length === 0) {
		return { openThreadIds, activeThreadId: null };
	}
	const nextActive = openThreadIds[Math.min(index, openThreadIds.length - 1)] ?? null;
	return { openThreadIds, activeThreadId: nextActive };
}

/** Activate an already-open session tab. No-op (same ref) when the tab is not open or already active. */
export function setActiveSessionTab(state: FullscreenTabsState, threadId: string): FullscreenTabsState {
	if (!state.openThreadIds.includes(threadId) || state.activeThreadId === threadId) {
		return state;
	}
	return { ...state, activeThreadId: threadId };
}

/** Activate the Home tab (the launcher), keeping the open session tabs intact. */
export function activateHomeTab(state: FullscreenTabsState): FullscreenTabsState {
	return state.activeThreadId === null ? state : { ...state, activeThreadId: null };
}

/**
 * Continuity rule, docked → fullscreen: restore the persisted open tab set + active tab.
 * When nothing is persisted yet, seed the current docked conversation as the first tab so the
 * round-trip never lands on an empty Home with the conversation lost; with no current
 * conversation either, open straight to the Home tab.
 */
export function reconcileOnEnterFullscreen(
	persisted: FullscreenTabsState,
	compactActiveThreadId: string | null,
): FullscreenTabsState {
	if (persisted.openThreadIds.length > 0) {
		return persisted;
	}
	if (compactActiveThreadId) {
		return { openThreadIds: [compactActiveThreadId], activeThreadId: compactActiveThreadId };
	}
	return EMPTY;
}

/**
 * Continuity rule, fullscreen → docked: the active session tab becomes the docked
 * conversation. When the Home tab was active, keep the current docked conversation.
 */
export function deriveCompactActiveOnExit(
	fullscreenActiveThreadId: string | null,
	currentCompactActiveId: string,
): string {
	return fullscreenActiveThreadId ?? currentCompactActiveId;
}
