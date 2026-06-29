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
 * Pi's own sessions for the Pi tab: every created thread bound to pi, in registry order.
 * Non-pi threads and the synthetic cross-agent default are excluded, so the list is empty
 * until the user creates the first pi session — no default/base session is presented.
 */
export function derivePiSessions(threads: HomeThread[]): HomeThread[] {
	return threads.filter((thread) => !thread.isDefault && thread.agentId === PI_AGENT_ID);
}

/** Clamp a requested active id to one that still exists, else the first session — or null when the list is empty. */
export function resolveActivePiSessionId(sessions: HomeThread[], requestedId: string | null): string | null {
	if (requestedId && sessions.some((session) => session.id === requestedId)) {
		return requestedId;
	}
	return sessions[0]?.id ?? null;
}

/** After hard-closing a session, drop the active selection only when the closed one was active. */
export function nextActivePiSessionAfterClose(closedId: string, currentActiveId: string | null): string | null {
	return currentActiveId === closedId ? null : currentActiveId;
}
