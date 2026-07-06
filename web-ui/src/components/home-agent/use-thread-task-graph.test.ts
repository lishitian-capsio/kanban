import { describe, expect, it } from "vitest";

import { buildThreadTaskGraph } from "@/components/home-agent/use-thread-task-graph";
import type { RuntimeBoardColumnId, RuntimeBoardDependency } from "@/runtime/types";

function meta(entries: [string, string, RuntimeBoardColumnId][]): Map<string, { title: string; columnId: RuntimeBoardColumnId }> {
	return new Map(entries.map(([id, title, columnId]) => [id, { title, columnId }]));
}

function dep(id: string, fromTaskId: string, toTaskId: string): RuntimeBoardDependency {
	return { id, fromTaskId, toTaskId, createdAt: 0 };
}

describe("buildThreadTaskGraph", () => {
	it("records direction: `from` blocks `to`; `to` is waiting on `from`", () => {
		const graph = buildThreadTaskGraph(
			[dep("d1", "backlog1", "started1")],
			meta([
				["backlog1", "Backlog one", "backlog"],
				["started1", "Started one", "in_progress"],
			]),
		);
		expect(graph.get("backlog1")?.blocking).toEqual([
			{ dependencyId: "d1", taskId: "started1", title: "Started one", columnId: "in_progress" },
		]);
		expect(graph.get("backlog1")?.waitingOn).toEqual([]);
		expect(graph.get("started1")?.waitingOn).toEqual([
			{ dependencyId: "d1", taskId: "backlog1", title: "Backlog one", columnId: "backlog" },
		]);
		expect(graph.get("started1")?.blocking).toEqual([]);
	});

	it("drops edges whose endpoints are not both in the thread's task set", () => {
		const graph = buildThreadTaskGraph(
			[dep("d1", "backlog1", "outsider"), dep("d2", "outsider", "started1")],
			meta([
				["backlog1", "Backlog one", "backlog"],
				["started1", "Started one", "review"],
			]),
		);
		// Neither edge has both endpoints inside the thread → empty graph.
		expect(graph.size).toBe(0);
	});

	it("accumulates multiple edges per task", () => {
		const graph = buildThreadTaskGraph(
			[dep("d1", "b1", "s1"), dep("d2", "b2", "s1")],
			meta([
				["b1", "Backlog one", "backlog"],
				["b2", "Backlog two", "backlog"],
				["s1", "Started", "in_progress"],
			]),
		);
		expect(graph.get("s1")?.waitingOn.map((r) => r.taskId).sort()).toEqual(["b1", "b2"]);
	});
});
