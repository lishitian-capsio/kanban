import type { RuntimeTaskSessionSummary } from "@/runtime/types";

/**
 * Resolve the question a task agent raised when it parked the task in review.
 *
 * Today the agent's closing message is carried on the session summary's last
 * hook activity (`finalMessage`) — the same text the board card already renders
 * as the review activity line. We surface it here as "the review question" the
 * Ask action routes.
 *
 * Seam: the dedicated Ask-B `reviewQuestion` field (a structured question the
 * agent explicitly flags for human/kanban-agent routing) is being added on the
 * backend in parallel. When `RuntimeTaskSessionSummary` gains that field, prefer
 * it here and fall back to `finalMessage` — callers don't change.
 */
export function resolveTaskReviewQuestion(summary: RuntimeTaskSessionSummary | null | undefined): string | null {
	if (!summary || summary.state !== "awaiting_review") {
		return null;
	}
	const finalMessage = summary.latestHookActivity?.finalMessage?.trim();
	return finalMessage && finalMessage.length > 0 ? finalMessage : null;
}
