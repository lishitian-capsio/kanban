import type React from "react";
import { useCallback } from "react";

import { nextSelectedIndex, resolveSearchNavAction } from "./search-nav";

export interface UseSearchKeyboardInput {
	count: number;
	selectedIndex: number;
	setSelectedIndex: (index: number) => void;
	onOpen: () => void;
	onClose: () => void;
}

/**
 * Wire the pure {@link resolveSearchNavAction}/{@link nextSelectedIndex} logic into a
 * keydown handler for a search input: ArrowUp/Down move the highlight (wrapping),
 * Enter opens the highlighted result, Escape closes. Returns a handler to attach to
 * the search `<input onKeyDown>`.
 */
export function useSearchKeyboard({
	count,
	selectedIndex,
	setSelectedIndex,
	onOpen,
	onClose,
}: UseSearchKeyboardInput): (event: React.KeyboardEvent) => void {
	return useCallback(
		(event: React.KeyboardEvent) => {
			const action = resolveSearchNavAction(event.key);
			if (!action) {
				return;
			}
			event.preventDefault();
			if (action === "next" || action === "previous") {
				setSelectedIndex(nextSelectedIndex(selectedIndex, action, count));
			} else if (action === "open") {
				onOpen();
			} else {
				onClose();
			}
		},
		[count, selectedIndex, setSelectedIndex, onOpen, onClose],
	);
}
