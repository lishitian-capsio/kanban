/**
 * Pure classification + message shaping for high-signal task lifecycle → IM notifications.
 *
 * This is the network-free, side-effect-free core of the IM task notifier (requirement ac99c):
 * it decides *which* session-summary transitions are worth pushing to a bound IM channel and
 * *what* the outbound payload looks like. The stateful routing / dedup / dispatch lives in
 * {@link ./im-task-notifier}; keeping this piece pure makes the routing-mapping + message shape
 * exhaustively unit-testable.
 *
 * Design notes:
 * - Only a *real state transition* (a non-null `previous` whose state differs from `next`) emits.
 *   A null `previous` means "first observation" (a fresh connect or a post-restart re-seed), which
 *   is deliberately silent so a runtime restart never re-notifies tasks already parked in a state.
 * - We never react to `task_chat_message` tokens here — only coarse state transitions — so the
 *   channel stays high-signal and can't be spammed per streamed token.
 */
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { ImCard, ImTextMessage } from "./types";

/**
 * A high-signal task lifecycle event worth delivering to a bound IM channel.
 * - `started`: a session entered `running` (covers chained auto-start of a dependent task).
 * - `ready_for_review`: a session parked in `awaiting_review` via a review hook.
 * - `needs_attention`: a session is waiting on the human (needs input / confirmation).
 * - `error`: a session ended in error and needs a human.
 * - `complete`: a session finished cleanly (process exit).
 */
export type ImTaskEventKind = "started" | "ready_for_review" | "needs_attention" | "error" | "complete";

/**
 * Map a session-summary transition to a high-signal IM event, or `null` when the transition is not
 * noteworthy. See the module note for why a null `previous` (baseline seed) is intentionally silent.
 */
export function classifyImTaskEvent(
	previous: RuntimeTaskSessionSummary | null,
	next: RuntimeTaskSessionSummary,
): ImTaskEventKind | null {
	if (!previous) {
		// First observation of this task's session (fresh connect / post-restart re-seed). Seed a
		// baseline silently so we don't re-announce tasks that were already running/parked.
		return null;
	}
	if (previous.state === next.state) {
		return null;
	}
	if (next.state === "running") {
		return "started";
	}
	if (next.state === "awaiting_review") {
		switch (next.reviewReason) {
			case "error":
				return "error";
			case "attention":
				return "needs_attention";
			case "exit":
				return "complete";
			// "hook" and any unclassified awaiting_review reason → treat as a review request.
			default:
				return "ready_for_review";
		}
	}
	// Transitions into idle / interrupted / failed are not surfaced to IM (low signal / noisy).
	return null;
}

const CARD_KINDS: ReadonlySet<ImTaskEventKind> = new Set<ImTaskEventKind>([
	"ready_for_review",
	"needs_attention",
	"error",
]);

/**
 * Whether a kind should be delivered as a rich interactive card (review / needs-confirmation) vs a
 * plain text line (started / complete).
 */
export function isImTaskCardKind(kind: ImTaskEventKind): boolean {
	return CARD_KINDS.has(kind);
}

/** Context needed to render a task event into an outbound payload. */
export interface ImTaskMessageContext {
	taskId: string;
	title?: string | null;
	warningMessage?: string | null;
}

/** A shaped outbound payload: either a plain-text message or a rich card. */
export type BuiltImTaskMessage = { type: "text"; message: ImTextMessage } | { type: "card"; card: ImCard };

/**
 * Render a classified event into a platform-agnostic outbound payload. Review / needs-attention /
 * error use an interactive card; started / complete use a plain-text line.
 */
export function buildImTaskMessage(kind: ImTaskEventKind, ctx: ImTaskMessageContext): BuiltImTaskMessage {
	const label = ctx.title?.trim() ? ctx.title.trim() : ctx.taskId;
	switch (kind) {
		case "started":
			return { type: "text", message: { text: `▶️ 任务已启动：${label}` } };
		case "complete":
			return { type: "text", message: { text: `✅ 任务已完成：${label}` } };
		case "ready_for_review":
			return { type: "card", card: { title: "任务待复核", text: `任务「${label}」已完成本轮，等待你的复核。` } };
		case "needs_attention":
			return { type: "card", card: { title: "任务需要你处理", text: `任务「${label}」需要你的输入或确认。` } };
		case "error": {
			const detail = ctx.warningMessage?.trim() ? `：${ctx.warningMessage.trim()}` : "";
			return { type: "card", card: { title: "任务出错", text: `任务「${label}」运行出错${detail}，需要你处理。` } };
		}
	}
}
