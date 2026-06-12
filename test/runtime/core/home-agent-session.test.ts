import { describe, expect, it } from "vitest";

import {
	createHomeAgentSessionId,
	DEFAULT_HOME_THREAD_ID,
	isHomeAgentSessionId,
	isHomeAgentSessionIdForWorkspace,
	parseHomeAgentSessionId,
	resolveHomeAgentId,
} from "../../../src/core/home-agent-session";

describe("home agent session id", () => {
	describe("createHomeAgentSessionId", () => {
		it("emits the legacy three-segment id for the default thread", () => {
			expect(createHomeAgentSessionId("workspace-1", "pi")).toBe("__home_agent__:workspace-1:pi");
		});

		it("emits the legacy three-segment id when the default thread id is passed explicitly", () => {
			expect(createHomeAgentSessionId("workspace-1", "pi", DEFAULT_HOME_THREAD_ID)).toBe(
				"__home_agent__:workspace-1:pi",
			);
		});

		it("appends a fourth segment for a non-default thread", () => {
			expect(createHomeAgentSessionId("workspace-1", "claude", "abc123")).toBe(
				"__home_agent__:workspace-1:claude:abc123",
			);
		});
	});

	describe("parseHomeAgentSessionId", () => {
		it("parses a legacy three-segment id with the default thread id", () => {
			expect(parseHomeAgentSessionId("__home_agent__:workspace-1:pi")).toEqual({
				workspaceId: "workspace-1",
				agentId: "pi",
				threadId: DEFAULT_HOME_THREAD_ID,
			});
		});

		it("parses a four-segment id with the explicit thread id", () => {
			expect(parseHomeAgentSessionId("__home_agent__:workspace-1:claude:abc123")).toEqual({
				workspaceId: "workspace-1",
				agentId: "claude",
				threadId: "abc123",
			});
		});

		it("round-trips a non-default thread id", () => {
			const sessionId = createHomeAgentSessionId("ws", "codex", "thread-x");
			expect(parseHomeAgentSessionId(sessionId)).toEqual({
				workspaceId: "ws",
				agentId: "codex",
				threadId: "thread-x",
			});
		});

		it("returns null for a non-home session id", () => {
			expect(parseHomeAgentSessionId("some-task-id")).toBeNull();
		});

		it("returns null when the workspace or agent segment is missing", () => {
			expect(parseHomeAgentSessionId("__home_agent__:workspace-1")).toBeNull();
		});
	});

	describe("isHomeAgentSessionId", () => {
		it("is true for both legacy and threaded ids", () => {
			expect(isHomeAgentSessionId("__home_agent__:workspace-1:pi")).toBe(true);
			expect(isHomeAgentSessionId("__home_agent__:workspace-1:pi:abc")).toBe(true);
		});

		it("is false for non-home ids", () => {
			expect(isHomeAgentSessionId("task-1")).toBe(false);
		});
	});

	describe("isHomeAgentSessionIdForWorkspace", () => {
		it("matches both legacy and threaded ids for the workspace", () => {
			expect(isHomeAgentSessionIdForWorkspace("__home_agent__:workspace-1:pi", "workspace-1")).toBe(true);
			expect(isHomeAgentSessionIdForWorkspace("__home_agent__:workspace-1:pi:abc", "workspace-1")).toBe(true);
		});

		it("does not match a different workspace", () => {
			expect(isHomeAgentSessionIdForWorkspace("__home_agent__:workspace-2:pi", "workspace-1")).toBe(false);
		});
	});

	describe("resolveHomeAgentId", () => {
		it("returns the agent encoded in a legacy three-segment id", () => {
			expect(resolveHomeAgentId("__home_agent__:workspace-1:claude")).toBe("claude");
		});

		it("returns the agent (not the thread) for a four-segment threaded id", () => {
			expect(resolveHomeAgentId("__home_agent__:workspace-1:claude:thread-2")).toBe("claude");
		});

		it("returns null for a non-home session id", () => {
			expect(resolveHomeAgentId("4f1c2d3e-task-uuid")).toBeNull();
		});

		it("returns null when the encoded agent is not a known runtime agent", () => {
			expect(resolveHomeAgentId("__home_agent__:workspace-1:not-a-real-agent")).toBeNull();
		});

		it("returns null when the id has no agent segment", () => {
			expect(resolveHomeAgentId("__home_agent__:workspace-1")).toBeNull();
		});
	});
});
