import { describe, expect, it } from "vitest";

import { resolveCreateTaskAgentId, resolveCreateTaskOriginThreadId } from "../../../src/core/default-task-agent";

const HOME_CLAUDE = "__home_agent__:workspace-1:claude";
const HOME_PI = "__home_agent__:workspace-1:pi";
const HOME_CLAUDE_THREAD = "__home_agent__:workspace-1:claude:thread-7";
const REGULAR_TASK_ID = "4f1c2d3e-task-uuid";

describe("resolveCreateTaskAgentId", () => {
	it("returns the explicit agent id even when the caller is a different home agent", () => {
		expect(
			resolveCreateTaskAgentId({
				explicitAgentId: "codex",
				callerSessionId: HOME_CLAUDE,
			}),
		).toBe("codex");
	});

	it("returns undefined for an explicit default (null) even when a home caller is present", () => {
		// `null` means the user explicitly chose the workspace default (--agent-id default);
		// the explicit choice wins over the caller, and a missing override resolves to
		// selectedAgentId lazily at start time.
		expect(
			resolveCreateTaskAgentId({
				explicitAgentId: null,
				callerSessionId: HOME_CLAUDE,
			}),
		).toBeUndefined();
	});

	it("inherits the calling home chat's agent when no explicit flag is passed", () => {
		expect(
			resolveCreateTaskAgentId({
				explicitAgentId: undefined,
				callerSessionId: HOME_CLAUDE,
			}),
		).toBe("claude");
		expect(
			resolveCreateTaskAgentId({
				explicitAgentId: undefined,
				callerSessionId: HOME_PI,
			}),
		).toBe("pi");
	});

	it("returns undefined when the caller is a regular (non-home) task id", () => {
		// Parent-task → subtask agent inheritance is intentionally out of scope; a plain
		// task id falls back to the workspace default at start time.
		expect(
			resolveCreateTaskAgentId({
				explicitAgentId: undefined,
				callerSessionId: REGULAR_TASK_ID,
			}),
		).toBeUndefined();
	});

	it("returns undefined when there is no caller session id", () => {
		expect(resolveCreateTaskAgentId({ explicitAgentId: undefined, callerSessionId: undefined })).toBeUndefined();
		expect(resolveCreateTaskAgentId({ explicitAgentId: undefined, callerSessionId: "" })).toBeUndefined();
	});

	it("returns undefined when the home caller encodes an unknown agent", () => {
		expect(
			resolveCreateTaskAgentId({
				explicitAgentId: undefined,
				callerSessionId: "__home_agent__:workspace-1:not-a-real-agent",
			}),
		).toBeUndefined();
	});
});

describe("resolveCreateTaskOriginThreadId", () => {
	it("returns the explicit thread id even when the caller is a home session", () => {
		expect(
			resolveCreateTaskOriginThreadId({
				explicitThreadId: "thread-explicit",
				callerSessionId: HOME_CLAUDE_THREAD,
			}),
		).toBe("thread-explicit");
	});

	it("trims an explicit thread id and ignores a whitespace-only one", () => {
		expect(resolveCreateTaskOriginThreadId({ explicitThreadId: "  thread-9  " })).toBe("thread-9");
		expect(
			resolveCreateTaskOriginThreadId({
				explicitThreadId: "   ",
				callerSessionId: HOME_CLAUDE_THREAD,
			}),
		).toBe("thread-7");
	});

	it("derives the originating thread from a four-segment home caller session", () => {
		expect(resolveCreateTaskOriginThreadId({ callerSessionId: HOME_CLAUDE_THREAD })).toBe("thread-7");
	});

	it("derives the default thread from a legacy three-segment home caller session", () => {
		// A sidebar agent chatting in the default thread still genuinely originated the task
		// from that session, so it is stamped with the default thread id (not left unset).
		expect(resolveCreateTaskOriginThreadId({ callerSessionId: HOME_CLAUDE })).toBe("default");
		expect(resolveCreateTaskOriginThreadId({ callerSessionId: HOME_PI })).toBe("default");
	});

	it("returns undefined for a regular (non-home) caller task id", () => {
		expect(resolveCreateTaskOriginThreadId({ callerSessionId: REGULAR_TASK_ID })).toBeUndefined();
	});

	it("returns undefined when neither an explicit id nor a caller session is present", () => {
		expect(resolveCreateTaskOriginThreadId({})).toBeUndefined();
		expect(resolveCreateTaskOriginThreadId({ explicitThreadId: "", callerSessionId: "" })).toBeUndefined();
	});
});
