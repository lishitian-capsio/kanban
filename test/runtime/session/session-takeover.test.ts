import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import {
	classifyTakeoverEvent,
	renderTakeoverPrompt,
	SessionTakeoverCoordinator,
	type TakeoverTarget,
} from "../../../src/session/session-takeover";

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/repo",
		pid: 1,
		startedAt: 0,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function transition(
	from: { state: RuntimeTaskSessionState; reviewReason?: RuntimeTaskSessionSummary["reviewReason"] },
	to: Partial<RuntimeTaskSessionSummary>,
): [RuntimeTaskSessionSummary, RuntimeTaskSessionSummary] {
	return [summary({ state: from.state, reviewReason: from.reviewReason ?? null }), summary(to)];
}

describe("classifyTakeoverEvent", () => {
	it("returns null on first observation (no prev)", () => {
		expect(classifyTakeoverEvent(undefined, summary({ state: "awaiting_review", reviewReason: "hook" }))).toBeNull();
	});

	it("classifies running → awaiting_review (hook) as review", () => {
		const [prev, next] = transition({ state: "running" }, { state: "awaiting_review", reviewReason: "hook" });
		expect(classifyTakeoverEvent(prev, next)).toBe("review");
	});

	it("classifies plan-mode review as plan_ready", () => {
		const [prev, next] = transition(
			{ state: "running" },
			{ state: "awaiting_review", reviewReason: "hook", mode: "plan" },
		);
		expect(classifyTakeoverEvent(prev, next)).toBe("plan_ready");
	});

	it("classifies awaiting_review with reason error as failure", () => {
		const [prev, next] = transition({ state: "running" }, { state: "awaiting_review", reviewReason: "error" });
		expect(classifyTakeoverEvent(prev, next)).toBe("failure");
	});

	it("classifies entering failed as failure", () => {
		const [prev, next] = transition({ state: "running" }, { state: "failed" });
		expect(classifyTakeoverEvent(prev, next)).toBe("failure");
	});

	it("does not re-fire while already in awaiting_review", () => {
		const [prev, next] = transition(
			{ state: "awaiting_review", reviewReason: "hook" },
			{ state: "awaiting_review", reviewReason: "hook" },
		);
		expect(classifyTakeoverEvent(prev, next)).toBeNull();
	});

	it("ignores benign transitions (e.g. back to running)", () => {
		const [prev, next] = transition({ state: "awaiting_review", reviewReason: "hook" }, { state: "running" });
		expect(classifyTakeoverEvent(prev, next)).toBeNull();
	});
});

describe("renderTakeoverPrompt", () => {
	it("is neutral and includes the task id, event, and extension", () => {
		const prompt = renderTakeoverPrompt({
			event: "review",
			taskId: "task-9",
			title: "Add widget",
			summary: summary({ reviewReason: "hook" }),
			extension: "playbook",
		});
		expect(prompt).toContain("task-9");
		expect(prompt).toContain("Add widget");
		expect(prompt).toContain("playbook");
		// No verdict/convergence language (decision 43f28).
		expect(prompt).not.toMatch(/approve|reject|打回|判过/i);
	});
});

describe("SessionTakeoverCoordinator", () => {
	const homeSessionId = createHomeAgentSessionId("ws1", "claude", "thread-1");

	function makeCoordinator(target: TakeoverTarget | null) {
		const deliver = vi.fn(async () => undefined);
		const resolveTarget = vi.fn(async () => target);
		const coordinator = new SessionTakeoverCoordinator({ resolveTarget, deliver });
		return { coordinator, deliver, resolveTarget };
	}

	it("delivers once on a review transition when the thread switch is on", async () => {
		const { coordinator, deliver } = makeCoordinator({ sessionId: homeSessionId });
		coordinator.handleSummary("ws1", summary({ state: "running" }));
		coordinator.handleSummary("ws1", summary({ state: "awaiting_review", reviewReason: "hook" }));
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
		expect(deliver).toHaveBeenCalledWith(homeSessionId, expect.stringContaining("task-1"));
	});

	it("does not deliver when there is no target (no origin / switch off)", async () => {
		const { coordinator, deliver, resolveTarget } = makeCoordinator(null);
		coordinator.handleSummary("ws1", summary({ state: "running" }));
		coordinator.handleSummary("ws1", summary({ state: "awaiting_review", reviewReason: "hook" }));
		await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalled());
		expect(deliver).not.toHaveBeenCalled();
	});

	it("never manages the home sessions themselves (no self-trigger loop)", async () => {
		const { coordinator, resolveTarget } = makeCoordinator({ sessionId: homeSessionId });
		coordinator.handleSummary("ws1", summary({ taskId: homeSessionId, state: "running" }));
		coordinator.handleSummary(
			"ws1",
			summary({ taskId: homeSessionId, state: "awaiting_review", reviewReason: "hook" }),
		);
		// Give any erroneously-scheduled async dispatch a tick to run.
		await Promise.resolve();
		expect(resolveTarget).not.toHaveBeenCalled();
	});
});
