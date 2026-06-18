import { describe, expect, it } from "vitest";
import { resolveCreateTaskOriginSession } from "../../../src/core/default-task-agent";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";

describe("resolveCreateTaskOriginSession", () => {
	it("returns the caller session id when it is a home agent session", () => {
		const sessionId = createHomeAgentSessionId("ws1", "claude", "thread-7");
		expect(resolveCreateTaskOriginSession(sessionId)).toBe(sessionId);
	});

	it("returns the legacy three-segment default home session id verbatim", () => {
		const sessionId = createHomeAgentSessionId("ws1", "pi");
		expect(resolveCreateTaskOriginSession(sessionId)).toBe(sessionId);
	});

	it("returns undefined for a non-home caller (e.g. a task id)", () => {
		expect(resolveCreateTaskOriginSession("task-123")).toBeUndefined();
	});

	it("returns undefined when no caller session is present", () => {
		expect(resolveCreateTaskOriginSession(undefined)).toBeUndefined();
		expect(resolveCreateTaskOriginSession("")).toBeUndefined();
	});
});
