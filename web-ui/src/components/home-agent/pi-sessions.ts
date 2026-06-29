// Pure, side-effect-free model for the fullscreen Pi tab's multi-session manager.
//
// A "pi session" is a home chat thread bound to the native agent (`agentId === "pi"`);
// the 4-segment synthetic session id distinguishes multiple of them within the Pi tab.
// The Pi tab no longer pins a synthetic "default" base session: the always-present
// default home session was retired from the fullscreen experience (the Pi tab IS its
// replacement). The reserved DEFAULT_HOME_THREAD_ID / legacy three-segment id is left
// untouched as a backward-compat value — the historical pi default transcript stays
// reachable via the compact sidebar's default thread, just not surfaced here. Keeping
// this derivation pure makes the session-list + active-selection semantics unit-testable
// and decoupled from React.
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentId } from "@/runtime/types";

// The native agent id. `isNativeAgentSelected` (runtime/native-agent.ts) is itself
// `agentId === "pi"`, so the literal is the established house style here.
export const PI_AGENT_ID: RuntimeAgentId = "pi";

/**
 * Pi's own sessions for the Pi tab: every created thread bound to pi. The synthetic
 * cross-agent default thread (and any non-pi thread) is excluded — the Pi tab manages
 * only real, explicitly-created pi sessions and starts empty until the user creates one.
 */
export function derivePiSessions(threads: HomeThread[]): HomeThread[] {
	return threads.filter((thread) => !thread.isDefault && thread.agentId === PI_AGENT_ID);
}

/**
 * Clamp a requested active id to one that still exists, else fall back to the first
 * session. Returns `null` when there are no pi sessions (the Pi tab shows its empty state).
 */
export function resolveActivePiSessionId(sessions: HomeThread[], requestedId: string | null): string | null {
	if (requestedId && sessions.some((session) => session.id === requestedId)) {
		return requestedId;
	}
	return sessions[0]?.id ?? null;
}

/**
 * After hard-closing a session, drop the active selection when the closed one was active
 * (the caller re-resolves to the first remaining session, or `null` when none remain);
 * otherwise keep the current selection.
 */
export function nextActivePiSessionAfterClose(closedId: string, currentActiveId: string | null): string | null {
	return currentActiveId === closedId ? null : currentActiveId;
}
