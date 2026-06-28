// Pure, side-effect-free model for the fullscreen Pi tab's multi-session manager.
//
// A "pi session" is a home chat thread bound to the native agent (`agentId === "pi"`);
// the 4-segment synthetic session id distinguishes multiple of them within the Pi tab.
// One pinned **base** session always exists: it reuses the reserved
// DEFAULT_HOME_THREAD_ID, which `createHomeAgentSessionId` maps to the legacy
// three-segment id (`__home_agent__:<ws>:pi`) — so the historical single pi chat keeps
// its transcript/resume with no migration. Keeping this derivation pure makes the
// session-list + active-selection semantics unit-testable and decoupled from React.
import { DEFAULT_HOME_THREAD_ID } from "@runtime-home-agent-session";

import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentId } from "@/runtime/types";

// The native agent id. `isNativeAgentSelected` (runtime/native-agent.ts) is itself
// `agentId === "pi"`, so the literal is the established house style here.
export const PI_AGENT_ID: RuntimeAgentId = "pi";

/**
 * The pinned base pi session. Its id is the reserved DEFAULT_HOME_THREAD_ID (legacy
 * three-segment session id, always pi, never closable), so existing pi transcripts
 * reconnect unchanged. Pinned to pi regardless of the workspace-global agent.
 */
export function buildPiBaseSession(): HomeThread {
	return {
		id: DEFAULT_HOME_THREAD_ID,
		agentId: PI_AGENT_ID,
		name: "Default",
		titleSource: "manual",
		createdAt: 0,
		updatedAt: 0,
		isDefault: true,
	};
}

/**
 * Pi's own sessions for the Pi tab: the pinned base session followed by every created
 * thread bound to pi. Non-pi threads and the synthetic cross-agent default are excluded
 * (the base above stands in for the pi default), so the list never duplicates an entry.
 */
export function derivePiSessions(threads: HomeThread[]): HomeThread[] {
	const created = threads.filter((thread) => !thread.isDefault && thread.agentId === PI_AGENT_ID);
	return [buildPiBaseSession(), ...created];
}

/** Clamp a requested active id to one that still exists, else fall back to the first (base) session. */
export function resolveActivePiSessionId(sessions: HomeThread[], requestedId: string | null): string {
	if (requestedId && sessions.some((session) => session.id === requestedId)) {
		return requestedId;
	}
	return sessions[0]?.id ?? DEFAULT_HOME_THREAD_ID;
}

/** After hard-closing a session, the active selection falls back to the base only when the closed one was active. */
export function nextActivePiSessionAfterClose(closedId: string, currentActiveId: string): string {
	return currentActiveId === closedId ? DEFAULT_HOME_THREAD_ID : currentActiveId;
}
