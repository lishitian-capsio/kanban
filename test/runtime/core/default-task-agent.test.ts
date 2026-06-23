import { describe, expect, it } from "vitest";

import { resolveCreateTaskAgentId, resolveCreateTaskOrigin } from "../../../src/core/default-task-agent";

const HOME_CLAUDE = "__home_agent__:workspace-1:claude";
const HOME_PI = "__home_agent__:workspace-1:pi";
const HOME_PI_THREAD = "__home_agent__:workspace-1:pi:thread-abc";
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

describe("resolveCreateTaskOrigin", () => {
	it("captures the agent and explicit thread of a home caller session", () => {
		expect(resolveCreateTaskOrigin(HOME_PI_THREAD)).toEqual({ agentId: "pi", threadId: "thread-abc" });
	});

	it("captures the default thread for a legacy three-segment home session", () => {
		expect(resolveCreateTaskOrigin(HOME_CLAUDE)).toEqual({ agentId: "claude", threadId: "default" });
	});

	it("returns undefined for a regular (non-home) task caller", () => {
		// A subtask created by a task agent has no home thread to route an Ask back to.
		expect(resolveCreateTaskOrigin(REGULAR_TASK_ID)).toBeUndefined();
	});

	it("returns undefined when there is no caller session id", () => {
		expect(resolveCreateTaskOrigin(undefined)).toBeUndefined();
		expect(resolveCreateTaskOrigin("")).toBeUndefined();
	});

	it("returns undefined when the home caller encodes an unknown agent", () => {
		expect(resolveCreateTaskOrigin("__home_agent__:workspace-1:not-a-real-agent")).toBeUndefined();
	});
});
