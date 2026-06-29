import { DEFAULT_HOME_THREAD_ID } from "@runtime-home-agent-session";
import { describe, expect, it } from "vitest";

import {
	derivePiSessions,
	nextActivePiSessionAfterClose,
	resolveActivePiSessionId,
} from "@/components/home-agent/pi-sessions";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentId } from "@/runtime/types";

function makeThread(overrides: Partial<HomeThread> & { id: string; agentId: RuntimeAgentId }): HomeThread {
	return {
		name: overrides.name ?? overrides.id,
		titleSource: "manual",
		createdAt: 0,
		updatedAt: 0,
		isDefault: false,
		...overrides,
	};
}

describe("derivePiSessions", () => {
	it("returns only created pi threads, excluding the synthetic default and non-pi threads", () => {
		const threads: HomeThread[] = [
			makeThread({ id: DEFAULT_HOME_THREAD_ID, agentId: "claude", isDefault: true }),
			makeThread({ id: "pi-1", agentId: "pi" }),
			makeThread({ id: "claude-1", agentId: "claude" }),
			makeThread({ id: "pi-2", agentId: "pi" }),
		];
		const sessions = derivePiSessions(threads);
		expect(sessions.map((s) => s.id)).toEqual(["pi-1", "pi-2"]);
		expect(sessions.every((s) => s.agentId === "pi")).toBe(true);
	});

	it("excludes a default thread even when it is itself pi (compat lives in the sidebar, not here)", () => {
		const threads: HomeThread[] = [
			makeThread({ id: DEFAULT_HOME_THREAD_ID, agentId: "pi", isDefault: true }),
			makeThread({ id: "pi-1", agentId: "pi" }),
		];
		expect(derivePiSessions(threads).map((s) => s.id)).toEqual(["pi-1"]);
	});

	it("yields an empty list when there are no created pi threads", () => {
		expect(derivePiSessions([makeThread({ id: "claude-1", agentId: "claude" })])).toEqual([]);
	});
});

describe("resolveActivePiSessionId", () => {
	const sessions = derivePiSessions([makeThread({ id: "pi-1", agentId: "pi" })]);

	it("keeps a requested id that still exists", () => {
		expect(resolveActivePiSessionId(sessions, "pi-1")).toBe("pi-1");
	});

	it("falls back to the first session when the requested id is gone", () => {
		expect(resolveActivePiSessionId(sessions, "pi-gone")).toBe("pi-1");
	});

	it("falls back to the first session when nothing is requested", () => {
		expect(resolveActivePiSessionId(sessions, null)).toBe("pi-1");
	});

	it("returns null when there are no sessions", () => {
		expect(resolveActivePiSessionId([], null)).toBeNull();
		expect(resolveActivePiSessionId([], "pi-anything")).toBeNull();
	});
});

describe("nextActivePiSessionAfterClose", () => {
	it("drops the selection (caller re-resolves) when the closed session was active", () => {
		expect(nextActivePiSessionAfterClose("pi-1", "pi-1")).toBeNull();
	});

	it("keeps the current selection when a non-active session is closed", () => {
		expect(nextActivePiSessionAfterClose("pi-2", "pi-1")).toBe("pi-1");
	});

	it("tolerates a null current selection", () => {
		expect(nextActivePiSessionAfterClose("pi-1", null)).toBeNull();
	});
});
