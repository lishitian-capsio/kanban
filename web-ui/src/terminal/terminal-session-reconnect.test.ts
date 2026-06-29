import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	describeTerminalReconnect,
	isTerminalSessionLive,
	shouldAutoRelaunchTerminalSession,
} from "@/terminal/terminal-session-reconnect";

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "t1",
		state: "idle" as RuntimeTaskSessionState,
		agentId: "claude",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		agentSessionId: null,
		...overrides,
	} as RuntimeTaskSessionSummary;
}

describe("isTerminalSessionLive", () => {
	it("is live only while running or awaiting review", () => {
		expect(isTerminalSessionLive(makeSummary({ state: "running" }))).toBe(true);
		expect(isTerminalSessionLive(makeSummary({ state: "awaiting_review" }))).toBe(true);
		expect(isTerminalSessionLive(makeSummary({ state: "idle" }))).toBe(false);
		expect(isTerminalSessionLive(makeSummary({ state: "interrupted" }))).toBe(false);
		expect(isTerminalSessionLive(makeSummary({ state: "failed" }))).toBe(false);
	});
});

describe("shouldAutoRelaunchTerminalSession", () => {
	it("relaunches a dead terminal session in an active column", () => {
		expect(
			shouldAutoRelaunchTerminalSession({
				summary: makeSummary({ state: "idle", agentId: "claude" }),
				columnId: "in_progress",
			}),
		).toBe(true);
	});

	it("relaunches a dead session in the review column", () => {
		expect(
			shouldAutoRelaunchTerminalSession({
				summary: makeSummary({ state: "interrupted", agentId: "codex" }),
				columnId: "review",
			}),
		).toBe(true);
	});

	it("does not relaunch a live session", () => {
		expect(
			shouldAutoRelaunchTerminalSession({
				summary: makeSummary({ state: "running", agentId: "claude" }),
				columnId: "in_progress",
			}),
		).toBe(false);
		expect(
			shouldAutoRelaunchTerminalSession({
				summary: makeSummary({ state: "awaiting_review", agentId: "claude" }),
				columnId: "review",
			}),
		).toBe(false);
	});

	it("ignores non-active columns", () => {
		expect(
			shouldAutoRelaunchTerminalSession({
				summary: makeSummary({ state: "idle", agentId: "claude" }),
				columnId: "backlog",
			}),
		).toBe(false);
		expect(
			shouldAutoRelaunchTerminalSession({
				summary: makeSummary({ state: "idle", agentId: "claude" }),
				columnId: "trash",
			}),
		).toBe(false);
	});

	it("ignores the native pi agent (chat panel, not a terminal)", () => {
		expect(
			shouldAutoRelaunchTerminalSession({
				summary: makeSummary({ state: "idle", agentId: "pi" }),
				columnId: "in_progress",
			}),
		).toBe(false);
	});

	it("ignores sessions with no recorded agent", () => {
		expect(
			shouldAutoRelaunchTerminalSession({
				summary: makeSummary({ state: "idle", agentId: null }),
				columnId: "in_progress",
			}),
		).toBe(false);
	});

	it("does nothing without a summary", () => {
		expect(shouldAutoRelaunchTerminalSession({ summary: null, columnId: "in_progress" })).toBe(false);
	});
});

describe("describeTerminalReconnect", () => {
	it("resumes the conversation when a session id was recorded", () => {
		const plan = describeTerminalReconnect(makeSummary({ agentId: "claude", agentSessionId: "abc-123" }));
		expect(plan.willResumeConversation).toBe(true);
		expect(plan.noticeMessage).toBeNull();
	});

	it("starts fresh and explains when no session id exists", () => {
		const plan = describeTerminalReconnect(makeSummary({ agentId: "gemini", agentSessionId: null }));
		expect(plan.willResumeConversation).toBe(false);
		expect(plan.noticeMessage).toContain("Gemini");
		expect(plan.noticeMessage).toMatch(/fresh/i);
	});
});
