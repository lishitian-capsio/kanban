import { describe, expect, it, vi } from "vitest";

import { buildThreadTaskActions } from "@/components/home-agent/thread-task-action-list";
import type { HomeThreadTask, HomeThreadTaskActions } from "@/components/home-agent/thread-tasks";

function makeActions(): HomeThreadTaskActions {
	return {
		onStartTask: vi.fn(),
		onMoveTaskToDone: vi.fn(),
		onDeleteTask: vi.fn(),
		onOpenTask: vi.fn(),
	};
}

function task(columnId: HomeThreadTask["columnId"]): HomeThreadTask {
	return { id: "t", title: "Title", columnId };
}

describe("buildThreadTaskActions", () => {
	it("offers Start only for backlog tasks", () => {
		expect(buildThreadTaskActions(task("backlog"), makeActions()).map((a) => a.key)).toEqual([
			"start",
			"done",
			"open",
			"delete",
		]);
		expect(buildThreadTaskActions(task("in_progress"), makeActions()).map((a) => a.key)).not.toContain("start");
	});

	it("hides Move to Done for already-done tasks", () => {
		expect(buildThreadTaskActions(task("trash"), makeActions()).map((a) => a.key)).toEqual(["open", "delete"]);
		expect(buildThreadTaskActions(task("review"), makeActions()).map((a) => a.key)).toContain("done");
	});

	it("wires each action to the matching callback", () => {
		const actions = makeActions();
		const built = buildThreadTaskActions(task("backlog"), actions);
		for (const action of built) {
			action.run();
		}
		expect(actions.onStartTask).toHaveBeenCalledWith("t");
		expect(actions.onMoveTaskToDone).toHaveBeenCalledWith("t");
		expect(actions.onOpenTask).toHaveBeenCalledWith("t");
		expect(actions.onDeleteTask).toHaveBeenCalledWith("t");
	});
});
