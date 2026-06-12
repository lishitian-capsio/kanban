/**
 * Pure keyboard-navigation helpers shared by the vault search panel and the
 * quick-open palette. Kept free of React/DOM so the list movement and key mapping
 * are unit-testable in isolation.
 */

export type SearchNavMove = "next" | "previous";
export type SearchNavAction = SearchNavMove | "open" | "close";

/** Map a `KeyboardEvent.key` to a navigation action, or null if not handled. */
export function resolveSearchNavAction(key: string): SearchNavAction | null {
	switch (key) {
		case "ArrowDown":
			return "next";
		case "ArrowUp":
			return "previous";
		case "Enter":
			return "open";
		case "Escape":
			return "close";
		default:
			return null;
	}
}

/**
 * Move the highlighted index by one, wrapping at both ends. An out-of-range
 * `current` is clamped into the list first; an empty list always yields 0.
 */
export function nextSelectedIndex(current: number, move: SearchNavMove, count: number): number {
	if (count <= 0) {
		return 0;
	}
	const clamped = Math.min(Math.max(current, 0), count - 1);
	const delta = move === "next" ? 1 : -1;
	return (clamped + delta + count) % count;
}
