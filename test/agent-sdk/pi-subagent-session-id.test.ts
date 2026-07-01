import { describe, expect, it } from "vitest";
import {
	createPiSubagentSessionId,
	isPiSubagentSessionId,
	parsePiSubagentSessionId,
} from "../../src/agent-sdk/kanban/pi-subagent-session-id";

describe("pi-subagent-session-id", () => {
	it("round-trips a home-agent parent id (contains ':' and '_')", () => {
		const parent = "__home_agent__:ws-123:pi";
		const id = createPiSubagentSessionId(parent, "abc123");
		expect(isPiSubagentSessionId(id)).toBe(true);
		expect(parsePiSubagentSessionId(id)).toEqual({ parentTaskId: parent, subagentId: "abc123" });
	});

	it("round-trips a parent id that itself contains the separator", () => {
		const parent = "weird#parent#id";
		const id = createPiSubagentSessionId(parent, "sub-1");
		expect(parsePiSubagentSessionId(id)).toEqual({ parentTaskId: parent, subagentId: "sub-1" });
	});

	it("rejects a non-subagent id", () => {
		expect(isPiSubagentSessionId("__home_agent__:ws:pi")).toBe(false);
		expect(parsePiSubagentSessionId("task-42")).toBeNull();
		expect(parsePiSubagentSessionId("pi-sub#")).toBeNull();
		expect(parsePiSubagentSessionId("pi-sub#parent#")).toBeNull();
	});

	it("throws when the subagentId has disallowed characters", () => {
		expect(() => createPiSubagentSessionId("p", "bad#id")).toThrow();
		expect(() => createPiSubagentSessionId("p", "bad id")).toThrow();
	});
});
