import type { RuntimeTaskSessionState } from "../core/api-contract";

/**
 * The agent's closing question/request, captured when a task cleanly enters
 * review. This is the carrier behind the "Ask" review action: a task agent that
 * finishes a turn typically signs off with a question ("I did X — should I do Y
 * next?"), and that text is surfaced as a stable, review-scoped field rather than
 * being left buried in the volatile hook-activity blob.
 *
 * Pure and side-effect free: both the terminal session manager and the pi event
 * adapter funnel their `RuntimeTaskSessionSummary` updates through this so the
 * derivation stays identical across agents.
 *
 * Semantics:
 * - Only `awaiting_review` carries a closing question. `interrupted` turns were
 *   cut off mid-stream, so their trailing text is not a deliberate sign-off and
 *   must not masquerade as one; every other (active/terminal) state clears it.
 * - In review, a fresh non-blank `finalMessage` wins; otherwise the previously
 *   captured question is preserved so routine summary bumps (lastOutputAt, etc.)
 *   don't wipe it.
 */
export function deriveReviewQuestion(
	state: RuntimeTaskSessionState,
	finalMessage: string | null | undefined,
	previous: string | null | undefined,
): string | null {
	if (state !== "awaiting_review") {
		return null;
	}
	const trimmed = finalMessage?.trim();
	if (trimmed) {
		return trimmed;
	}
	return previous ?? null;
}
