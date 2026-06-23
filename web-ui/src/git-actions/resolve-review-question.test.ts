import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { resolveTaskReviewQuestion } from "./resolve-review-question";

function summary(overrides: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "t1",
		state: "awaiting_review",
		agentId: "pi",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: "attention",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	} as RuntimeTaskSessionSummary;
}

describe("resolveTaskReviewQuestion", () => {
	it("returns null when there is no summary", () => {
		expect(resolveTaskReviewQuestion(null)).toBeNull();
		expect(resolveTaskReviewQuestion(undefined)).toBeNull();
	});

	it("returns null when the task is not awaiting review", () => {
		const result = resolveTaskReviewQuestion(
			summary({
				state: "running",
				latestHookActivity: { finalMessage: "Should I use approach A or B?" } as never,
			}),
		);
		expect(result).toBeNull();
	});

	it("returns the trimmed final message when awaiting review", () => {
		const result = resolveTaskReviewQuestion(
			summary({
				latestHookActivity: { finalMessage: "  Should I use approach A or B?  " } as never,
			}),
		);
		expect(result).toBe("Should I use approach A or B?");
	});

	it("returns null when the final message is blank or missing", () => {
		expect(resolveTaskReviewQuestion(summary({ latestHookActivity: { finalMessage: "   " } as never }))).toBeNull();
		expect(resolveTaskReviewQuestion(summary({ latestHookActivity: { finalMessage: null } as never }))).toBeNull();
		expect(resolveTaskReviewQuestion(summary({ latestHookActivity: null }))).toBeNull();
	});
});
