import type { RuntimeAgentId } from "./api-contract";
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

export interface ResolveCreateTaskOriginThreadIdInput {
	/**
	 * An explicitly requested origin thread id (e.g. `task create --origin-thread-id`),
	 * for callers that already know the thread. A trimmed non-empty value always wins.
	 */
	explicitThreadId?: string | undefined;
	/**
	 * The caller's session id, read from `KANBAN_SESSION_TASK_ID` at the CLI boundary.
	 * When it encodes a home chat session (the sidebar agent created the task), that
	 * session's thread becomes the new task's origin so the fullscreen UI can group it
	 * under the conversation that spawned it.
	 */
	callerSessionId?: string | undefined;
}

/**
 * Resolve the home thread id to stamp as a new task's origin.
 *
 * Precedence: explicit `--origin-thread-id` > the calling home chat's thread > `undefined`.
 *
 * A home caller in the legacy default thread resolves to {@link DEFAULT_HOME_THREAD_ID}
 * (`"default"`), not `undefined`: the agent genuinely originated the task from that
 * session. Only a non-home caller (a plain task id, or no session at all) leaves the
 * task unattributed.
 *
 * Pure and never throws — mirrors {@link resolveCreateTaskAgentId}.
 */
export function resolveCreateTaskOriginThreadId(input: ResolveCreateTaskOriginThreadIdInput): string | undefined {
	const explicit = input.explicitThreadId?.trim();
	if (explicit) {
		return explicit;
	}
	if (input.callerSessionId) {
		const parsed = parseHomeAgentSessionId(input.callerSessionId);
		if (parsed) {
			return parsed.threadId;
		}
	}
	return undefined;
}
