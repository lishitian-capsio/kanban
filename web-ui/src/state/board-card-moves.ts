import type { BoardColumnId, BoardData } from "@/types";

const EMPTY_CARD_ID_SET: ReadonlySet<string> = new Set<string>();

function indexCardColumns(board: BoardData): Map<string, BoardColumnId> {
	const index = new Map<string, BoardColumnId>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			index.set(card.id, column.id);
		}
	}
	return index;
}

/**
 * Card ids that changed column between two consecutive board snapshots.
 *
 * A card that moves columns is re-parented into a different `<Droppable>` subtree,
 * so React unmounts it from the source column and mounts a brand-new element in the
 * destination column — stable `key`s only preserve identity within a single parent,
 * never across two. On that fresh mount the card's `content-visibility: auto` body
 * has no remembered intrinsic size, so the browser skips painting its contents for
 * one frame (the "flicker": the card briefly collapses to its placeholder height and
 * then pops back in). Callers feed this set back into the moved card so it can opt
 * out of culling for exactly that first paint.
 *
 * Cards present in only one snapshot (just created / just removed) are NOT reported:
 * they are not column moves and need no special paint handling.
 */
export function findColumnChangedCardIds(previous: BoardData | null | undefined, next: BoardData): ReadonlySet<string> {
	if (!previous) {
		return EMPTY_CARD_ID_SET;
	}
	const previousColumns = indexCardColumns(previous);
	const changed = new Set<string>();
	for (const column of next.columns) {
		for (const card of column.cards) {
			const previousColumnId = previousColumns.get(card.id);
			if (previousColumnId !== undefined && previousColumnId !== column.id) {
				changed.add(card.id);
			}
		}
	}
	return changed.size > 0 ? changed : EMPTY_CARD_ID_SET;
}
