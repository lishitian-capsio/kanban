import { beforeEach, describe, expect, it } from "vitest";

import { evaluateKanbanAsk, MAX_KANBAN_ASK_ITERATIONS, recordKanbanAsk, resetKanbanAsk } from "./ask-guardrail";

describe("ask-guardrail", () => {
	beforeEach(() => {
		resetKanbanAsk("task");
	});

	it("allows the first ask with a zero count", () => {
		expect(evaluateKanbanAsk("task")).toEqual({ allowed: true, count: 0 });
	});

	it("counts recorded asks and blocks once the cap is reached", () => {
		for (let i = 0; i < MAX_KANBAN_ASK_ITERATIONS; i += 1) {
			expect(evaluateKanbanAsk("task").allowed).toBe(true);
			recordKanbanAsk("task");
		}
		const decision = evaluateKanbanAsk("task");
		expect(decision.allowed).toBe(false);
		expect(decision.count).toBe(MAX_KANBAN_ASK_ITERATIONS);
		expect(decision.reason).toMatch(/kanban agent/i);
	});

	it("tracks counts independently per task", () => {
		recordKanbanAsk("task");
		expect(evaluateKanbanAsk("other").count).toBe(0);
		resetKanbanAsk("other");
	});

	it("resets a task's count", () => {
		recordKanbanAsk("task");
		resetKanbanAsk("task");
		expect(evaluateKanbanAsk("task").count).toBe(0);
	});
});
