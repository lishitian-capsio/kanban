import { describe, expect, it } from "vitest";
import type {
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { buildImTaskMessage, classifyImTaskEvent, isImTaskCardKind } from "../../../src/im/im-task-event";

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/repo",
		pid: 123,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function transition(
	prevState: RuntimeTaskSessionState | null,
	nextState: RuntimeTaskSessionState,
	reviewReason: RuntimeTaskSessionReviewReason = null,
): { previous: RuntimeTaskSessionSummary | null; next: RuntimeTaskSessionSummary } {
	return {
		previous: prevState === null ? null : summary({ state: prevState }),
		next: summary({ state: nextState, reviewReason, updatedAt: 100 }),
	};
}

describe("classifyImTaskEvent", () => {
	it("returns null for a null previous (baseline seed, restart-safe)", () => {
		expect(classifyImTaskEvent(null, summary({ state: "awaiting_review", reviewReason: "hook" }))).toBeNull();
		expect(classifyImTaskEvent(null, summary({ state: "running" }))).toBeNull();
	});

	it("returns null when the state did not change", () => {
		const { previous, next } = transition("running", "running");
		expect(classifyImTaskEvent(previous, next)).toBeNull();
	});

	it("classifies idle -> running as started (chained auto-start)", () => {
		const { previous, next } = transition("idle", "running");
		expect(classifyImTaskEvent(previous, next)).toBe("started");
	});

	it("classifies running -> awaiting_review(hook) as ready_for_review", () => {
		const { previous, next } = transition("running", "awaiting_review", "hook");
		expect(classifyImTaskEvent(previous, next)).toBe("ready_for_review");
	});

	it("classifies running -> awaiting_review(attention) as needs_attention", () => {
		const { previous, next } = transition("running", "awaiting_review", "attention");
		expect(classifyImTaskEvent(previous, next)).toBe("needs_attention");
	});

	it("classifies running -> awaiting_review(error) as error", () => {
		const { previous, next } = transition("running", "awaiting_review", "error");
		expect(classifyImTaskEvent(previous, next)).toBe("error");
	});

	it("classifies running -> awaiting_review(exit) as complete", () => {
		const { previous, next } = transition("running", "awaiting_review", "exit");
		expect(classifyImTaskEvent(previous, next)).toBe("complete");
	});

	it("treats awaiting_review with an unknown/null reason as ready_for_review", () => {
		const { previous, next } = transition("running", "awaiting_review", null);
		expect(classifyImTaskEvent(previous, next)).toBe("ready_for_review");
	});

	it("returns null for transitions into idle or interrupted (not high-signal)", () => {
		expect(classifyImTaskEvent(summary({ state: "running" }), summary({ state: "idle" }))).toBeNull();
		expect(
			classifyImTaskEvent(
				summary({ state: "running" }),
				summary({ state: "interrupted", reviewReason: "interrupted" }),
			),
		).toBeNull();
	});
});

describe("isImTaskCardKind", () => {
	it("routes review/attention/error to a card and started/complete to text", () => {
		expect(isImTaskCardKind("ready_for_review")).toBe(true);
		expect(isImTaskCardKind("needs_attention")).toBe(true);
		expect(isImTaskCardKind("error")).toBe(true);
		expect(isImTaskCardKind("started")).toBe(false);
		expect(isImTaskCardKind("complete")).toBe(false);
	});
});

describe("buildImTaskMessage", () => {
	it("builds text for started/complete with the task title", () => {
		const started = buildImTaskMessage("started", { taskId: "t1", title: "Fix login" });
		expect(started.type).toBe("text");
		if (started.type === "text") {
			expect(started.message.text).toContain("Fix login");
		}
		const complete = buildImTaskMessage("complete", { taskId: "t1", title: "Fix login" });
		expect(complete.type).toBe("text");
	});

	it("builds a card for ready_for_review/needs_attention with a title + body", () => {
		const card = buildImTaskMessage("ready_for_review", { taskId: "t1", title: "Fix login" });
		expect(card.type).toBe("card");
		if (card.type === "card") {
			expect(card.card.title).toBeTruthy();
			expect(card.card.text).toContain("Fix login");
		}
	});

	it("includes the warning message in an error card when present", () => {
		const card = buildImTaskMessage("error", { taskId: "t1", title: "Fix login", warningMessage: "boom" });
		expect(card.type).toBe("card");
		if (card.type === "card") {
			expect(card.card.text).toContain("boom");
		}
	});

	it("falls back to the taskId when no title is available", () => {
		const built = buildImTaskMessage("complete", { taskId: "task-xyz", title: null });
		expect(built.type).toBe("text");
		if (built.type === "text") {
			expect(built.message.text).toContain("task-xyz");
		}
	});
});
