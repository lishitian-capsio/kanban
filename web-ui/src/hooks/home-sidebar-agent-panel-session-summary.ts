import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function selectNewestTaskSessionSummary(
	left: RuntimeTaskSessionSummary | null,
	right: RuntimeTaskSessionSummary | null,
): RuntimeTaskSessionSummary | null {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}
	// Prefer the newer arrival on a tie (strict `>`), not the existing one. The
	// backend stamps `updatedAt` with millisecond `Date.now()`, so a fast
	// state transition (e.g. running → awaiting_review during an auto-review /
	// chained-task flow) can land in the same millisecond as the prior summary.
	// With `>=` that newer state was silently dropped and the card stuck on its
	// old state/column until a browser refresh rebuilt sessions from a fresh
	// snapshot. `>` still guards against regressing to a strictly-older summary
	// (the "terminal randomly clears out" case), which is all the monotonic
	// guard ever needed.
	return left.updatedAt > right.updatedAt ? left : right;
}
