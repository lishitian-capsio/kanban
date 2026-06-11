import type { RuntimeAgentId } from "./api-contract";

// The home sidebar agent panel is not backed by a real task card.
// We mint a synthetic home agent session id so the existing task-scoped
// runtime APIs can manage its chat and terminal lifecycle without creating
// a worktree-backed task. Home sidebar sessions should use a stable synthetic
// task id so refreshes and session reloads can reconnect to the same chat.
const HOME_AGENT_SESSION_NAMESPACE = "__home_agent__";

export const HOME_AGENT_SESSION_PREFIX = `${HOME_AGENT_SESSION_NAMESPACE}:`;

/**
 * The implicit thread for a workspace + agent. The default thread keeps the
 * historical three-segment session id (`__home_agent__:<workspaceId>:<agentId>`)
 * so existing persisted transcripts, `sessions.json` summaries, and agent
 * resume reconnect without migration. Additional threads append a fourth
 * `:<threadId>` segment.
 */
export const DEFAULT_HOME_THREAD_ID = "default";

export interface HomeAgentSessionParts {
	workspaceId: string;
	agentId: string;
	threadId: string;
}

export function createHomeAgentSessionId(
	workspaceId: string,
	agentId: RuntimeAgentId,
	threadId: string = DEFAULT_HOME_THREAD_ID,
): string {
	const base = `${HOME_AGENT_SESSION_PREFIX}${workspaceId}:${agentId}`;
	if (threadId === DEFAULT_HOME_THREAD_ID) {
		return base;
	}
	return `${base}:${threadId}`;
}

export function isHomeAgentSessionId(sessionId: string): boolean {
	return sessionId.startsWith(HOME_AGENT_SESSION_PREFIX);
}

export function isHomeAgentSessionIdForWorkspace(sessionId: string, workspaceId: string): boolean {
	return sessionId.startsWith(`${HOME_AGENT_SESSION_PREFIX}${workspaceId}:`);
}

/**
 * Parse a home agent session id into its workspace, agent, and thread parts.
 *
 * Parsing is positional: after stripping the prefix, the first segment is the
 * workspace id, the second is the agent id, and an optional third segment is the
 * thread id (falling back to {@link DEFAULT_HOME_THREAD_ID}). This mirrors the
 * existing assumption in {@link isHomeAgentSessionIdForWorkspace} that the
 * workspace id is a single contiguous token; agent ids come from a fixed enum
 * and never contain a colon.
 */
export function parseHomeAgentSessionId(sessionId: string): HomeAgentSessionParts | null {
	if (!isHomeAgentSessionId(sessionId)) {
		return null;
	}
	const remainder = sessionId.slice(HOME_AGENT_SESSION_PREFIX.length);
	const parts = remainder.split(":");
	if (parts.length < 2) {
		return null;
	}
	const [workspaceId, agentId, threadId] = parts;
	if (!workspaceId || !agentId) {
		return null;
	}
	return {
		workspaceId,
		agentId,
		threadId: threadId || DEFAULT_HOME_THREAD_ID,
	};
}
