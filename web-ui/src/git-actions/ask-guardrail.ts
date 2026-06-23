// Loop guardrail for the "问 kanban agent" Ask route.
//
// Handing a task's review question to the kanban agent, which can in turn act on
// the task and push it back into review, is the shape of a potential automatic
// loop (review → ask kanban → kanban acts → review → ask kanban → …). Today the
// Ask action is human-initiated, so no loop can form on its own — but this module
// is the deliberate seam where the bound between "the kanban agent keeps trying"
// and "escalate to a human" is enforced, so future automatic re-asking can opt in
// without risking an unbounded cycle.
//
// v1 policy: count how many times a given task has been routed to the kanban
// agent within this app session and refuse past a hard cap, surfacing an
// escalate-to-human reason. The cap is intentionally small. Routing back to the
// task's own agent ("问自己") is not gated — it cannot form a cross-agent loop.

/** Hard cap on "问 kanban agent" routes per task within an app session. */
export const MAX_KANBAN_ASK_ITERATIONS = 3;

const kanbanAskCountByTaskId = new Map<string, number>();

export interface KanbanAskDecision {
	/** Whether another "问 kanban agent" route is permitted for this task. */
	allowed: boolean;
	/** How many times this task has already been routed to the kanban agent. */
	count: number;
	/** Present when `allowed` is false — a human-readable escalation reason. */
	reason?: string;
}

/** Evaluate (without recording) whether the kanban agent may be asked again. */
export function evaluateKanbanAsk(taskId: string): KanbanAskDecision {
	const count = kanbanAskCountByTaskId.get(taskId) ?? 0;
	if (count >= MAX_KANBAN_ASK_ITERATIONS) {
		return {
			allowed: false,
			count,
			reason: `This task has already been handed to the kanban agent ${count} times. Please review it yourself.`,
		};
	}
	return { allowed: true, count };
}

/** Record a successful "问 kanban agent" route for loop accounting. */
export function recordKanbanAsk(taskId: string): void {
	kanbanAskCountByTaskId.set(taskId, (kanbanAskCountByTaskId.get(taskId) ?? 0) + 1);
}

/** Clear a task's kanban-ask count (e.g. when it leaves review or is resolved). */
export function resetKanbanAsk(taskId: string): void {
	kanbanAskCountByTaskId.delete(taskId);
}
