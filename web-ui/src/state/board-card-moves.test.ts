import { describe, expect, it } from "vitest";

import { findColumnChangedCardIds } from "@/state/board-card-moves";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

function createCard(id: string): BoardCard {
	return {
		id,
		title: id,
		prompt: "Do the thing",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1_000,
		updatedAt: 1_000,
	};
}

function createBoard(layout: Partial<Record<BoardColumnId, string[]>>): BoardData {
	const columns = (Object.entries(layout) as [BoardColumnId, string[]][]).map(([id, cardIds]) => ({
		id,
		title: id,
		cards: cardIds.map(createCard),
	}));
	return { columns, dependencies: [] };
}

describe("findColumnChangedCardIds", () => {
	it("returns an empty set when there is no previous snapshot", () => {
		const next = createBoard({ backlog: ["a"], in_progress: ["b"] });
		expect(findColumnChangedCardIds(null, next).size).toBe(0);
		expect(findColumnChangedCardIds(undefined, next).size).toBe(0);
	});

	it("reports a card that moved to a different column", () => {
		const previous = createBoard({ backlog: ["a"], in_progress: ["b"] });
		const next = createBoard({ backlog: [], in_progress: ["b", "a"] });
		expect([...findColumnChangedCardIds(previous, next)]).toEqual(["a"]);
	});

	it("does not report cards that merely reordered within the same column", () => {
		const previous = createBoard({ in_progress: ["a", "b"] });
		const next = createBoard({ in_progress: ["b", "a"] });
		expect(findColumnChangedCardIds(previous, next).size).toBe(0);
	});

	it("does not report newly created or removed cards", () => {
		const previous = createBoard({ backlog: ["a"] });
		const next = createBoard({ backlog: ["a", "new"] });
		expect(findColumnChangedCardIds(previous, next).size).toBe(0);

		const afterRemoval = createBoard({ backlog: [] });
		expect(findColumnChangedCardIds(previous, afterRemoval).size).toBe(0);
	});

	it("reports every card that changed column in one transition", () => {
		const previous = createBoard({ backlog: ["a", "b"], review: ["c"] });
		const next = createBoard({ backlog: [], in_progress: ["a"], review: ["c"], trash: ["b"] });
		expect([...findColumnChangedCardIds(previous, next)].sort()).toEqual(["a", "b"]);
	});
});
