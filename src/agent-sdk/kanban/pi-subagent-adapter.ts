// Projects a Pi subagent's omp AgentEvent stream onto the PARENT session summary's
// `subagents[]` array (decision 647ea / X1). Subagents are not top-level sessions — their
// lifecycle/status/tokens live inside the parent summary so the Pi area's subagents rail can
// render them. The subagent's own transcript is handled separately (applyPiAgentEvent on a
// composite-id buffer); this module only maintains the summary projection.
import type { RuntimeTaskSessionSummary, RuntimeTaskSubagent, RuntimeTaskSubagentStatus } from "../../core/api-contract";
import { now } from "../../session/session-message";
import type { AgentEvent } from "../types";
import { accumulateUsage, extractErrorFromMessages } from "./pi-event-adapter";

export interface SubagentLifecycleContext {
	/** The composite transcript id (drill-in key) — persisted on the record as `sessionId`. */
	compositeId: string;
	/** Human label (the `task` tool's `description`). */
	label: string;
	/** Resolved model id for the subagent, when known. */
	modelId: string | null;
}

function statusForEvent(event: AgentEvent): RuntimeTaskSubagentStatus {
	if (event.type === "agent_end") {
		return extractErrorFromMessages(event.messages) ? "failed" : "done";
	}
	return "running";
}

/**
 * Return an updated `subagents[]` for the parent summary reflecting one child event.
 * Immutable: never mutates the input array/records. Creates the record on first sight of a
 * subagentId; on `agent_end` folds the run's token telemetry into the record's usage.
 */
export function applySubagentLifecycle(
	parentSummary: RuntimeTaskSessionSummary,
	subagentId: string,
	event: AgentEvent,
	ctx: SubagentLifecycleContext,
): RuntimeTaskSubagent[] {
	const timestamp = now();
	const existing = parentSummary.subagents ?? [];
	const index = existing.findIndex((entry) => entry.subagentId === subagentId);
	const status = statusForEvent(event);

	if (index === -1) {
		const created: RuntimeTaskSubagent = {
			subagentId,
			parentTaskId: parentSummary.taskId,
			sessionId: ctx.compositeId,
			label: ctx.label,
			status,
			modelId: ctx.modelId,
			usage: event.type === "agent_end" ? (accumulateUsage(null, event.telemetry) ?? null) : null,
			startedAt: timestamp,
			updatedAt: timestamp,
		};
		return [...existing, created];
	}

	const prior = existing[index];
	const updated: RuntimeTaskSubagent = {
		...prior,
		status,
		updatedAt: timestamp,
		usage: event.type === "agent_end" ? (accumulateUsage(prior.usage ?? null, event.telemetry) ?? prior.usage) : prior.usage,
	};
	const next = existing.slice();
	next[index] = updated;
	return next;
}
