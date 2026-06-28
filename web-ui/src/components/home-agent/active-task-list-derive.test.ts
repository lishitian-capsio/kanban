import { describe, expect, it } from "vitest";

import { selectActiveTasks } from "@/components/home-agent/active-task-list-derive";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";

function makeCard(id: string, title: string): RuntimeBoardCard {
	return {
		id,
		title,
		prompt: title,
		startInPlanMode: false,
		baseRef: "HEAD",
		createdAt: 0,
		updatedAt: 0,
	} as RuntimeBoardCard;
}

function makeBoard(columns: Array<{ id: RuntimeBoardColumnId; cards: RuntimeBoardCard[] }>): RuntimeBoardData {
	return {
		columns: columns.map((column) => ({ id: column.id, title: column.id, cards: column.cards })),
		dependencies: [],
	};
}

function makeSummary(state: RuntimeTaskSessionState, taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
	};
}

describe("selectActiveTasks", () => {
	it("returns only in_progress and review tasks, hiding backlog and done/trash", () => {
		const board = makeBoard([
			{ id: "backlog", cards: [makeCard("b1", "Backlog one")] },
			{ id: "in_progress", cards: [makeCard("p1", "Running one")] },
			{ id: "review", cards: [makeCard("r1", "Review one")] },
			{ id: "trash", cards: [makeCard("d1", "Done one")] },
		]);
		const entries = selectActiveTasks(board, {});
		expect(entries.map((entry) => entry.taskId)).toEqual(["p1", "r1"]);
	});

	it("orders in_progress before review, preserving board rank within each column", () => {
		const board = makeBoard([
			{ id: "review", cards: [makeCard("r1", "Review one"), makeCard("r2", "Review two")] },
			{ id: "in_progress", cards: [makeCard("p1", "Running one"), makeCard("p2", "Running two")] },
		]);
		const entries = selectActiveTasks(board, {});
		expect(entries.map((entry) => entry.taskId)).toEqual(["p1", "p2", "r1", "r2"]);
		expect(entries.map((entry) => entry.columnId)).toEqual(["in_progress", "in_progress", "review", "review"]);
	});

	it("attaches the matching session summary, or null when none exists", () => {
		const board = makeBoard([
			{ id: "in_progress", cards: [makeCard("p1", "Running one")] },
			{ id: "review", cards: [makeCard("r1", "Review one")] },
		]);
		const entries = selectActiveTasks(board, { p1: makeSummary("running", "p1") });
		expect(entries[0]?.summary?.state).toBe("running");
		expect(entries[1]?.summary).toBeNull();
	});

	it("returns an empty list for a null board or no active tasks", () => {
		expect(selectActiveTasks(null, {})).toEqual([]);
		expect(selectActiveTasks(makeBoard([{ id: "backlog", cards: [makeCard("b1", "Backlog")] }]), {})).toEqual([]);
	});

	it("resolves a card title from its prompt when title is unset", () => {
		const board = makeBoard([{ id: "in_progress", cards: [makeCard("p1", "Implement the thing")] }]);
		const entries = selectActiveTasks(board, {});
		expect(entries[0]?.title).toBe("Implement the thing");
	});
});
