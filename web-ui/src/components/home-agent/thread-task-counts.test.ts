import { describe, expect, it } from "vitest";

import { countThreadTasksByStatus } from "@/components/home-agent/thread-task-counts";
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "@/runtime/types";

let cardSeq = 0;
function card(originThreadId: string | undefined): RuntimeBoardCard {
	cardSeq += 1;
	return {
		id: `task-${cardSeq}`,
		title: `Task ${cardSeq}`,
		prompt: `prompt ${cardSeq}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...(originThreadId !== undefined ? { originThreadId } : {}),
	};
}

function board(columns: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	const ids: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
	return {
		columns: ids.map((id) => ({ id, title: id, cards: columns[id] ?? [] })),
		dependencies: [],
	};
}

describe("countThreadTasksByStatus", () => {
	it("counts a thread's tasks per active bucket, mapping trash → done", () => {
		const data = board({
			in_progress: [card("t1"), card("t1"), card("other")],
			review: [card("t1")],
			trash: [card("t1"), card("t1"), card("t1")],
		});

		expect(countThreadTasksByStatus(data, "t1")).toEqual({
			inProgress: 2,
			review: 1,
			done: 3,
			total: 6,
		});
	});

	it("excludes the backlog column from the counts", () => {
		const data = board({
			backlog: [card("t1"), card("t1")],
			in_progress: [card("t1")],
		});

		expect(countThreadTasksByStatus(data, "t1")).toEqual({
			inProgress: 1,
			review: 0,
			done: 0,
			total: 1,
		});
	});

	it("only counts tasks whose originThreadId matches the thread", () => {
		const data = board({
			in_progress: [card("t1"), card("t2"), card(undefined)],
		});

		expect(countThreadTasksByStatus(data, "t2")).toEqual({
			inProgress: 1,
			review: 0,
			done: 0,
			total: 1,
		});
	});

	it("returns all-zero counts for an unmatched thread, null board, or blank id", () => {
		const data = board({ in_progress: [card("t1")] });
		const zero = { inProgress: 0, review: 0, done: 0, total: 0 };

		expect(countThreadTasksByStatus(data, "nobody")).toEqual(zero);
		expect(countThreadTasksByStatus(null, "t1")).toEqual(zero);
		expect(countThreadTasksByStatus(data, "   ")).toEqual(zero);
	});

	it("matches the default thread's reserved id", () => {
		const data = board({ review: [card("default")], trash: [card("default")] });

		expect(countThreadTasksByStatus(data, "default")).toEqual({
			inProgress: 0,
			review: 1,
			done: 1,
			total: 2,
		});
	});
});
