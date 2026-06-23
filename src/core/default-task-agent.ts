import { type RuntimeAgentId, type RuntimeTaskOrigin, runtimeAgentIdSchema } from "./api-contract";
import { parseHomeAgentSessionId, resolveHomeAgentId } from "./home-agent-session";

export interface ResolveCreateTaskAgentIdInput {
	/**
	 * The explicitly requested agent for the new task:
	 * - a {@link RuntimeAgentId} when `--agent-id <id>` was passed,
	 * - `null` for an explicit `--agent-id default` (use the workspace default),
	 * - `undefined` when no `--agent-id` flag was passed at all.
	 */
	explicitAgentId: RuntimeAgentId | null | undefined;
	/**
	 * The session/task id of the caller, read from the `KANBAN_SESSION_TASK_ID`
	 * env var at the CLI boundary. When this encodes a home chat agent (e.g. an
	 * agent in the sidebar created the task), that agent becomes the new task's
	 * default so "the agent you're chatting with" is the agent the task runs.
	 */
	callerSessionId?: string | undefined;
}

/**
 * Resolve the agent id to stamp on a newly created task card.
 *
 * Precedence: explicit `--agent-id` > the calling home chat's agent > `undefined`.
 *
 * Returning `undefined` leaves the card without a per-task override, so the
 * workspace `selectedAgentId` applies lazily at session-start time — the same
 * behavior as the web-ui task-create dialog, which also leaves `agentId` unset
 * unless the user picks one. This is why `selectedAgentId` is not passed in
 * here: it is the start-time fallback, not a create-time stamp.
 *
 * This function is pure and never throws: an absent, non-home, or invalid caller
 * session id simply falls through to `undefined`.
 */
export function resolveCreateTaskAgentId(input: ResolveCreateTaskAgentIdInput): RuntimeAgentId | undefined {
	// An explicit choice always wins, including an explicit "default" (`null`),
	// which intentionally falls through to the workspace default at start time.
	if (input.explicitAgentId !== undefined) {
		return input.explicitAgentId ?? undefined;
	}
	// No explicit flag: inherit the calling home chat's agent when present.
	if (input.callerSessionId) {
		const callerAgentId = resolveHomeAgentId(input.callerSessionId);
		if (callerAgentId) {
			return callerAgentId;
		}
	}
	return undefined;
}

/**
 * Resolve the origin (home agent + thread) to stamp on a newly created task card.
 *
 * Reads the caller's `KANBAN_SESSION_TASK_ID` (passed in as `callerSessionId`):
 * when it encodes a home chat session, the task records which home thread/agent
 * created it so the "Ask" review action can later route a question back to that
 * thread. Like {@link resolveCreateTaskAgentId} this is pure and never throws —
 * an absent, non-home, or unknown-agent caller resolves to `undefined`, which
 * leaves the task originless (handled by the Ask fallback that opens a fresh
 * thread bound to the task).
 */
export function resolveCreateTaskOrigin(callerSessionId: string | undefined): RuntimeTaskOrigin | undefined {
	if (!callerSessionId) {
		return undefined;
	}
	const parts = parseHomeAgentSessionId(callerSessionId);
	if (!parts) {
		return undefined;
	}
	const agentId = runtimeAgentIdSchema.safeParse(parts.agentId).data;
	if (!agentId) {
		return undefined;
	}
	return { agentId, threadId: parts.threadId };
}
