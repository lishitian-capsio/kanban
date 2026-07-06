import { describe, expect, it } from "vitest";

import { collectThreadTaskCards, collectThreadTasks } from "@/components/home-agent/thread-tasks";
import type { RuntimeBoardData } from "@/runtime/types";

function makeBoard(): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{ id: "b1", title: "Backlog one", prompt: "", originThreadId: "t1" },
					{ id: "b2", title: "Other thread", prompt: "", originThreadId: "t2" },
					{ id: "b3", title: "No origin", prompt: "" },
				],
			},
			{
				id: "in_progress",
				title: "In progress",
				cards: [{ id: "p1", title: "Running", prompt: "", originThreadId: "t1" }],
			},
			{
				id: "review",
				title: "Review",
				cards: [{ id: "r1", title: "Reviewing", prompt: "", originThreadId: "t1" }],
			},
			{
				id: "trash",
				title: "Done",
				cards: [{ id: "d1", title: "Finished", prompt: "", originThreadId: "t1" }],
			},
		],
		dependencies: [],
	} as unknown as RuntimeBoardData;
}

describe("collectThreadTasks", () => {
	it("returns only the thread's tasks, in board order, across all columns", () => {
		const tasks = collectThreadTasks(makeBoard(), "t1");
		expect(tasks).toEqual([
			{ id: "b1", title: "Backlog one", columnId: "backlog" },
			{ id: "p1", title: "Running", columnId: "in_progress" },
			{ id: "r1", title: "Reviewing", columnId: "review" },
			{ id: "d1", title: "Finished", columnId: "trash" },
		]);
	});

	it("ignores cards belonging to other threads or with no origin", () => {
		const tasks = collectThreadTasks(makeBoard(), "t2");
		expect(tasks).toEqual([{ id: "b2", title: "Other thread", columnId: "backlog" }]);
	});

	it("returns [] for a null board or blank thread id", () => {
		expect(collectThreadTasks(null, "t1")).toEqual([]);
		expect(collectThreadTasks(makeBoard(), "")).toEqual([]);
		expect(collectThreadTasks(makeBoard(), "   ")).toEqual([]);
	});
});

describe("collectThreadTaskCards", () => {
	it("returns the full cards with their column id, in board order", () => {
		const cards = collectThreadTaskCards(makeBoard(), "t1");
		expect(cards.map(({ card, columnId }) => [card.id, columnId])).toEqual([
			["b1", "backlog"],
			["p1", "in_progress"],
			["r1", "review"],
			["d1", "trash"],
		]);
		// Full card carried through (not just id/title/column).
		expect(cards[0]?.card).toMatchObject({ id: "b1", title: "Backlog one", prompt: "" });
	});

	it("filters by originThreadId and returns [] for a null board or blank id", () => {
		expect(collectThreadTaskCards(makeBoard(), "t2").map(({ card }) => card.id)).toEqual(["b2"]);
		expect(collectThreadTaskCards(null, "t1")).toEqual([]);
		expect(collectThreadTaskCards(makeBoard(), "  ")).toEqual([]);
	});
});
