import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { createLogger } from "../logging";

const log = createLogger("session.takeover");

/**
 * The task state-machine transitions the takeover hook reacts to. Sourced from
 * session-summary transitions (see {@link classifyTakeoverEvent}), except `done`
 * which is a board-level concept (a task moving to a terminal column / merge into
 * base) that this branch does not yet implement — the value is reserved so the
 * enum and rendering are ready, but `classifyTakeoverEvent` never returns it.
 */
export type TakeoverEvent = "plan_ready" | "review" | "failure" | "done";

/**
 * Classify a session-summary transition into a takeover event, or `null` when the
 * transition is not one the takeover hook acts on. Pure and edge-triggered: a
 * missing `prev` (first observation / hydrated snapshot) never fires, so the hook
 * does not re-announce an already-resting state on startup.
 *
 * - `failure`: entering `failed`, or entering `awaiting_review` with reason `error`.
 * - `plan_ready`: entering `awaiting_review` (reason hook/attention/exit) while the
 *   session is in plan mode (the plan is presented for the user's decision).
 * - `review`: the same review entry while not in plan mode (a work turn finished).
 *
 * `done` is never returned here (board-level, not a session state — reserved).
 */
export function classifyTakeoverEvent(
	prev: RuntimeTaskSessionSummary | undefined,
	next: RuntimeTaskSessionSummary,
): TakeoverEvent | null {
	if (!prev) {
		return null;
	}
	if (next.state === "failed" && prev.state !== "failed") {
		return "failure";
	}
	if (prev.state !== "awaiting_review" && next.state === "awaiting_review") {
		if (next.reviewReason === "error") {
			return "failure";
		}
		if (next.reviewReason === "hook" || next.reviewReason === "attention" || next.reviewReason === "exit") {
			return next.mode === "plan" ? "plan_ready" : "review";
		}
	}
	return null;
}

export interface RenderTakeoverPromptInput {
	event: TakeoverEvent;
	taskId: string;
	title?: string | null;
	summary: RuntimeTaskSessionSummary;
	/** Optional takeover-extension reference (a vault document slug) for this thread. */
	extension?: string | null;
}

const EVENT_DESCRIPTION: Record<TakeoverEvent, string> = {
	plan_ready: "已给出方案,进入待审阅(plan ready)",
	review: "完成一轮工作,进入待审阅(review)",
	failure: "运行失败/出错(failure)",
	done: "已完成(done)",
};

/**
 * Render a takeover event into a neutral, agent-neutral prompt. Deliberately states
 * the event and hands control back — it does NOT instruct the agent to approve,
 * reject, or judge against requirements (decision 43f28: no convergence/verdict).
 * The attached extension reference, when present, points the agent at its own
 * authored guidance (vault-types-are-skills) without prescribing a flow here.
 */
export function renderTakeoverPrompt(input: RenderTakeoverPromptInput): string {
	const title = input.title?.trim();
	const lines: string[] = [];
	lines.push(`[Kanban 接管] 任务 ${input.taskId}${title ? `「${title}」` : ""} ${EVENT_DESCRIPTION[input.event]}。`);
	const detail: string[] = [];
	if (input.summary.reviewReason) {
		detail.push(`reviewReason=${input.summary.reviewReason}`);
	}
	if (typeof input.summary.exitCode === "number") {
		detail.push(`exitCode=${input.summary.exitCode}`);
	}
	if (input.summary.warningMessage) {
		detail.push(input.summary.warningMessage);
	}
	if (detail.length > 0) {
		lines.push(`状态: ${detail.join(" · ")}`);
	}
	if (input.extension?.trim()) {
		lines.push(`接管扩展: ${input.extension.trim()}(按需读取该文档的接管指引)。`);
	}
	lines.push("你在协调这条线程;请查看任务后决定下一步并回报用户。裁决权留用户。");
	return lines.join("\n");
}

/** The injected target + extension for a task's originating home thread. */
export interface TakeoverTarget {
	/** The originating home agent session id to inject into. */
	sessionId: string;
	/** Optional takeover-extension reference recorded on the thread. */
	extension?: string | null;
}

export interface SessionTakeoverCoordinatorDeps {
	/**
	 * Resolve the takeover target for a task whose session just transitioned:
	 * reads the task's `originHomeSessionId` and the originating thread's takeover
	 * switch, returning the target only when an origin exists AND its thread's
	 * switch is on. Returns `null` to skip (no origin, switch off, or any error).
	 * Read at event time so flipping the switch takes effect immediately.
	 */
	resolveTarget: (workspaceId: string, taskId: string) => Promise<TakeoverTarget | null>;
	/** Deliver the rendered prompt to the originating home session and trigger it. */
	deliver: (sessionId: string, prompt: string) => Promise<void>;
}

/**
 * In-process takeover hook. Subscribes (via the runtime state hub) to every task
 * session-summary update for both agent kinds, edge-detects the transitions in
 * {@link classifyTakeoverEvent}, and — when the task was originated by a home
 * thread whose takeover switch is on — renders the event and injects it back into
 * that thread's session. No websocket, no polling. All I/O is injected so the
 * coordinator is unit-testable; delivery failures are logged, never thrown.
 */
export class SessionTakeoverCoordinator {
	private readonly previousByKey = new Map<string, RuntimeTaskSessionSummary>();

	constructor(private readonly deps: SessionTakeoverCoordinatorDeps) {}

	handleSummary(workspaceId: string, summary: RuntimeTaskSessionSummary): void {
		// The home sessions themselves transition too; never manage them (they have
		// no task shard / origin binding) — this also rules out any self-trigger loop.
		if (isHomeAgentSessionId(summary.taskId)) {
			return;
		}
		const key = `${workspaceId}:${summary.taskId}`;
		const previous = this.previousByKey.get(key);
		this.previousByKey.set(key, summary);
		const event = classifyTakeoverEvent(previous, summary);
		if (!event) {
			return;
		}
		void this.dispatch(workspaceId, summary, event);
	}

	private async dispatch(
		workspaceId: string,
		summary: RuntimeTaskSessionSummary,
		event: TakeoverEvent,
	): Promise<void> {
		try {
			const target = await this.deps.resolveTarget(workspaceId, summary.taskId);
			if (!target) {
				return;
			}
			const prompt = renderTakeoverPrompt({
				event,
				taskId: summary.taskId,
				summary,
				extension: target.extension,
			});
			await this.deps.deliver(target.sessionId, prompt);
		} catch (error) {
			log.warn("takeover injection failed", {
				workspaceId,
				taskId: summary.taskId,
				event,
				error: error instanceof Error ? error : String(error),
			});
		}
	}
}
