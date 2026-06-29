import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	type CardSessionActivity,
	getCardSessionActivity,
	isCardCreditLimitError,
	SESSION_ACTIVITY_COLOR,
} from "@/utils/session-activity";

type HookActivity = NonNullable<RuntimeTaskSessionSummary["latestHookActivity"]>;

function makeSummary(
	state: RuntimeTaskSessionState,
	latestHookActivity: Partial<HookActivity> | null = null,
): RuntimeTaskSessionSummary {
	return {
		taskId: "t",
		state,
		agentId: "pi",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: latestHookActivity
			? {
					activityText: null,
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: null,
					notificationType: null,
					source: "pi",
					...latestHookActivity,
				}
			: null,
	} as RuntimeTaskSessionSummary;
}

describe("getCardSessionActivity", () => {
	it("returns null for a missing summary", () => {
		expect(getCardSessionActivity(null)).toBeNull();
		expect(getCardSessionActivity(undefined)).toBeNull();
	});

	it("returns null for an idle session with no hook activity", () => {
		expect(getCardSessionActivity(makeSummary("idle"))).toBeNull();
	});

	it("falls back to 'Thinking...' for a running session with no hook activity", () => {
		expect(getCardSessionActivity(makeSummary("running"))).toEqual<CardSessionActivity>({
			dotColor: SESSION_ACTIVITY_COLOR.thinking,
			text: "Thinking...",
		});
	});

	it("shows 'Waiting for review' (green) for an awaiting-review session with no message", () => {
		expect(getCardSessionActivity(makeSummary("awaiting_review"))).toEqual<CardSessionActivity>({
			dotColor: SESSION_ACTIVITY_COLOR.success,
			text: "Waiting for review",
		});
	});

	it("surfaces the final message (green) when awaiting review", () => {
		const activity = getCardSessionActivity(makeSummary("awaiting_review", { finalMessage: "Done with the change" }));
		expect(activity).toEqual<CardSessionActivity>({
			dotColor: SESSION_ACTIVITY_COLOR.success,
			text: "Done with the change",
		});
	});

	it("renders a compact tool-call label from a running tool hook", () => {
		const activity = getCardSessionActivity(
			makeSummary("running", {
				activityText: "Using Read",
				toolName: "Read",
				toolInputSummary: "src/index.ts",
				hookEventName: "tool_call",
			}),
		);
		expect(activity?.text).toBe("Read(src/index.ts)");
		expect(activity?.dotColor).toBe(SESSION_ACTIVITY_COLOR.thinking);
	});

	it("shows a streaming assistant message (blue) while running", () => {
		const activity = getCardSessionActivity(
			makeSummary("running", {
				finalMessage: "Looking at the file now",
				hookEventName: "assistant_delta",
			}),
		);
		expect(activity).toEqual<CardSessionActivity>({
			dotColor: SESSION_ACTIVITY_COLOR.thinking,
			text: "Looking at the file now",
		});
	});

	it("colors a failed tool activity red", () => {
		const activity = getCardSessionActivity(
			makeSummary("running", {
				activityText: "Failed Read: src/index.ts: ENOENT",
				toolName: "Read",
				hookEventName: "tool_result",
			}),
		);
		expect(activity?.dotColor).toBe(SESSION_ACTIVITY_COLOR.error);
	});

	it("does not render 'Thinking...' from a stale running-indicator once awaiting review", () => {
		// Terminal agents (Claude/Codex/…) set activityText to a running-indicator
		// like "Resumed after user input" / "Agent active" during a turn, but their
		// turn-end hook carries no final message, so the indicator is never cleared.
		// A settled (awaiting_review) session must read as idle/waiting, not Thinking.
		for (const stale of ["Resumed after user input", "Agent active", "Working on task"]) {
			expect(
				getCardSessionActivity(makeSummary("awaiting_review", { activityText: stale })),
			).toEqual<CardSessionActivity>({
				dotColor: SESSION_ACTIVITY_COLOR.success,
				text: "Waiting for review",
			});
		}
	});

	it("still shows 'Thinking...' from a running-indicator while genuinely running", () => {
		for (const live of ["Resumed after user input", "Agent active", "Working on task"]) {
			expect(getCardSessionActivity(makeSummary("running", { activityText: live }))).toEqual<CardSessionActivity>({
				dotColor: SESSION_ACTIVITY_COLOR.thinking,
				text: "Thinking...",
			});
		}
	});

	it("does not surface a stale running-indicator for an idle session", () => {
		expect(getCardSessionActivity(makeSummary("idle", { activityText: "Agent active" }))).toBeNull();
	});

	it("reports out-of-credits (orange) for a credit-limit hook", () => {
		const activity = getCardSessionActivity(makeSummary("failed", { notificationType: "credit_limit" }));
		expect(activity).toEqual<CardSessionActivity>({
			dotColor: SESSION_ACTIVITY_COLOR.warning,
			text: "Out of credits",
		});
	});

	it("falls back to a generic message for a failed session with no detail", () => {
		const activity = getCardSessionActivity(makeSummary("failed"));
		expect(activity).toEqual<CardSessionActivity>({
			dotColor: SESSION_ACTIVITY_COLOR.error,
			text: "Task failed to start",
		});
	});
});

describe("isCardCreditLimitError", () => {
	it("is true only for a terminal/review state carrying a credit_limit notification", () => {
		expect(isCardCreditLimitError(makeSummary("failed", { notificationType: "credit_limit" }))).toBe(true);
		expect(isCardCreditLimitError(makeSummary("awaiting_review", { notificationType: "credit_limit" }))).toBe(true);
		expect(isCardCreditLimitError(makeSummary("running", { notificationType: "credit_limit" }))).toBe(false);
		expect(isCardCreditLimitError(makeSummary("failed"))).toBe(false);
		expect(isCardCreditLimitError(null)).toBe(false);
	});
});
