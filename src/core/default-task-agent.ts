import type { RuntimeAgentId } from "./api-contract";
import { isHomeAgentSessionId, resolveHomeAgentId } from "./home-agent-session";

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
 * Resolve the originating home chat session to stamp on a newly created task.
 *
 * When a task is created from a home chat thread (the calling agent ran
 * `kanban task create` with `KANBAN_SESSION_TASK_ID` set to its home session id),
 * we record that full session id on the task so the takeover hook can route the
 * task's later state-machine transitions back to the originating thread.
 *
 * Recording is unconditional whenever an originating home session exists — it is
 * NOT gated on the thread's takeover switch (that switch only gates injection at
 * the exit). Human-created tasks (web-ui dialog) have no caller session and stay
 * unbound. Pure and never throws: an absent or non-home caller id → `undefined`.
 */
export function resolveCreateTaskOriginSession(callerSessionId?: string | undefined): string | undefined {
	if (callerSessionId && isHomeAgentSessionId(callerSessionId)) {
		return callerSessionId;
	}
	return undefined;
}
