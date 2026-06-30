// Pure, side-effect-free model for the fullscreen Pi tab's multi-session manager.
//
// A "pi session" is a home chat thread bound to the native agent (`agentId === "pi"`);
// the 4-segment synthetic session id distinguishes multiple of them within the Pi tab.
// The Pi tab does NOT preset the reserved DEFAULT_HOME_THREAD_ID base session: the list
// starts empty and the user creates the first session. The legacy default thread still
// exists at the home-thread layer (`createHomeAgentSessionId` maps `threadId === "default"`
// back to the three-segment id for transcript/resume backward-compat) — it is simply not
// surfaced here. Keeping this derivation pure makes the session-list + active-selection
// semantics unit-testable and decoupled from React.
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentId } from "@/runtime/types";

// The native agent id. `isNativeAgentSelected` (runtime/native-agent.ts) is itself
// `agentId === "pi"`, so the literal is the established house style here.
export const PI_AGENT_ID: RuntimeAgentId = "pi";

/**
 * A "pi session" is a created (non-default) home thread bound to the native agent. The
 * synthetic cross-agent default is never a pi session even when its agent is pi (it stays
 * a `HomeThreadBar` / launcher concern for backward-compatible transcript continuity).
 */
export function isPiSession(thread: HomeThread): boolean {
	return !thread.isDefault && thread.agentId === PI_AGENT_ID;
}

/**
 * Pi's own sessions, in registry order: every created thread bound to pi. The list is empty
 * until the user creates the first pi session — no default/base session is presented. This is
 * the single set the Pi-area session rail owns in both board and session (fullscreen) modes.
 */
export function derivePiSessions(threads: HomeThread[]): HomeThread[] {
	return threads.filter(isPiSession);
}

/**
 * Resolve the requested pi-session selection against the current list: keep it when it still
 * exists, else `null`. Unlike a clamp-to-first, `null` is a meaningful resting state — it means
 * "no pi session is focused", so the surface shows its non-pi fallback (the board dropdown's
 * thread / the fullscreen Home launcher) instead of forcing a pi conversation into view.
 */
export function resolvePiSessionSelection(sessions: HomeThread[], requestedId: string | null): string | null {
	if (requestedId && sessions.some((session) => session.id === requestedId)) {
		return requestedId;
	}
	return null;
}

/** After hard-closing a session, drop the active selection only when the closed one was active. */
export function nextActivePiSessionAfterClose(closedId: string, currentActiveId: string | null): string | null {
	return currentActiveId === closedId ? null : currentActiveId;
}
