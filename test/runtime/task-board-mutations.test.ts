import { describe, expect, it } from "vitest";

import { isTerminalBoardColumn, type RuntimeBoardData } from "../../src/core/api-contract";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	findOpenTasksForOriginThread,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("origin thread stamping", () => {
	it("stamps originThreadId on a new task when provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "From a thread", baseRef: "main", originThreadId: "thread-7" },
			() => "aaaaa111",
		);
		expect(created.task.originThreadId).toBe("thread-7");
	});

	it("omits originThreadId entirely when not provided (board-direct creation)", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Board direct", baseRef: "main" }, () => "bbbbb111");
		expect(created.task.originThreadId).toBeUndefined();
		expect("originThreadId" in created.task).toBe(false);
	});

	it("ignores a blank originThreadId", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Blank origin", baseRef: "main", originThreadId: "   " },
			() => "ccccc111",
		);
		expect("originThreadId" in created.task).toBe(false);
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("isTerminalBoardColumn", () => {
	it("treats trash (the done/trash terminal bucket) as terminal", () => {
		expect(isTerminalBoardColumn("trash")).toBe(true);
	});

	it("treats backlog, in_progress and review as non-terminal", () => {
		expect(isTerminalBoardColumn("backlog")).toBe(false);
		expect(isTerminalBoardColumn("in_progress")).toBe(false);
		expect(isTerminalBoardColumn("review")).toBe(false);
	});
});

describe("findOpenTasksForOriginThread", () => {
	function boardWithOriginTasks() {
		let board = createBoard();
		const backlog = addTaskToColumn(
			board,
			"backlog",
			{ prompt: "Backlog task", baseRef: "main", originThreadId: "t1" },
			() => "aaaaa111",
		);
		board = backlog.board;
		const wip = addTaskToColumn(
			board,
			"in_progress",
			{ prompt: "WIP task", baseRef: "main", originThreadId: "t1" },
			() => "bbbbb111",
		);
		board = wip.board;
		const review = addTaskToColumn(
			board,
			"review",
			{ prompt: "Review task", baseRef: "main", originThreadId: "t1" },
			() => "ccccc111",
		);
		board = review.board;
		const done = addTaskToColumn(
			board,
			"trash",
			{ prompt: "Done task", baseRef: "main", originThreadId: "t1" },
			() => "ddddd111",
		);
		board = done.board;
		const otherThread = addTaskToColumn(
			board,
			"backlog",
			{ prompt: "Other thread task", baseRef: "main", originThreadId: "t2" },
			() => "eeeee111",
		);
		board = otherThread.board;
		const threadless = addTaskToColumn(
			board,
			"backlog",
			{ prompt: "Threadless task", baseRef: "main" },
			() => "fffff111",
		);
		board = threadless.board;
		return { board, backlog, wip, review, done, otherThread };
	}

	it("returns only non-terminal tasks originated by the given thread", () => {
		const { board, backlog, wip, review } = boardWithOriginTasks();
		const open = findOpenTasksForOriginThread(board, "t1");
		expect(open.map((card) => card.id).sort()).toEqual([backlog.task.id, wip.task.id, review.task.id].sort());
	});

	it("excludes tasks in the done/trash terminal bucket", () => {
		const { board, done } = boardWithOriginTasks();
		const open = findOpenTasksForOriginThread(board, "t1");
		expect(open.some((card) => card.id === done.task.id)).toBe(false);
	});

	it("ignores tasks from other threads and threadless tasks", () => {
		const { board, otherThread } = boardWithOriginTasks();
		const open = findOpenTasksForOriginThread(board, "t2");
		expect(open.map((card) => card.id)).toEqual([otherThread.task.id]);
	});

	it("returns an empty array when the thread has no open tasks", () => {
		expect(findOpenTasksForOriginThread(createBoard(), "nobody")).toEqual([]);
	});
});

describe("per-task agent/model/provider overrides", () => {
	it("persists agentId on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Smart task", baseRef: "main", agentId: "claude" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("claude");
	});

	it("persists task-level Kanban settings on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Dumb task",
				baseRef: "main",
				agentId: "pi",
				agentSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("pi");
		expect(created.task.agentSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});

	it("leaves override fields undefined when not provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Default task", baseRef: "main" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBeUndefined();
		expect(created.task.agentSettings).toBeUndefined();
	});

	it("updates agentId from undefined to a value", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.agentId).toBeUndefined();

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.agentId).toBe("codex");
	});

	it("updates saved modelId", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", agentSettings: { modelId: "old-model" } },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentSettings: { modelId: "new-model" },
		});

		expect(updated.task?.agentSettings?.modelId).toBe("new-model");
	});

	it("preserves existing overrides when update input omits them (undefined)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "claude",
				agentSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "low",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Updated prompt",
			baseRef: "main",
			// agentId and agentSettings are undefined, so existing overrides should persist
		});

		expect(updated.task?.agentId).toBe("claude");
		expect(updated.task?.agentSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "low",
		});
	});

	it("clears overrides when update input provides null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "codex",
				agentSettings: {
					providerId: "openai",
					modelId: "gpt-4",
					reasoningEffort: "medium",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: null,
			agentSettings: null,
		});

		expect(updated.task?.agentId).toBeUndefined();
		expect(updated.task?.agentSettings).toBeUndefined();
	});

	it("preserves overrides across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Movable task",
				baseRef: "main",
				agentId: "claude",
				agentSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress");

		expect(moved.moved).toBe(true);
		expect(moved.task?.agentId).toBe("claude");
		expect(moved.task?.agentSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});
});

describe("task owner", () => {
	it("stores the owner identity supplied at creation", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Owned task", baseRef: "main", owner: { name: "Ada", email: "ada@example.com" } },
			() => "aaaaa111",
		);
		expect(created.task.owner).toEqual({ name: "Ada", email: "ada@example.com" });
	});

	it("leaves owner undefined when none is supplied", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.owner).toBeUndefined();
	});

	it("collapses a whitespace-only owner to undefined", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", owner: { name: "  ", email: " " } },
			() => "aaaaa111",
		);
		expect(created.task.owner).toBeUndefined();
	});

	it("keeps the existing owner when update omits it", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", owner: { name: "Ada", email: "ada@example.com" } },
			() => "aaaaa111",
		);
		const updated = updateTask(created.board, created.task.id, { prompt: "Task", baseRef: "main" });
		expect(updated.task?.owner).toEqual({ name: "Ada", email: "ada@example.com" });
	});

	it("overrides the owner when a new identity is provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", owner: { name: "Ada", email: "ada@example.com" } },
			() => "aaaaa111",
		);
		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			owner: { name: "Grace", email: "grace@example.com" },
		});
		expect(updated.task?.owner).toEqual({ name: "Grace", email: "grace@example.com" });
	});

	it("clears the owner when update passes null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", owner: { name: "Ada", email: "ada@example.com" } },
			() => "aaaaa111",
		);
		const updated = updateTask(created.board, created.task.id, { prompt: "Task", baseRef: "main", owner: null });
		expect(updated.task?.owner).toBeUndefined();
	});

	it("preserves owner across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", owner: { name: "Ada", email: "ada@example.com" } },
			() => "aaaaa111",
		);
		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress");
		expect(moved.task?.owner).toEqual({ name: "Ada", email: "ada@example.com" });
	});
});
