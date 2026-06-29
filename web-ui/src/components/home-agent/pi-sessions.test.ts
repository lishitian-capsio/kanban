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
	it("returns only created pi threads, in registry order", () => {
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

	it("excludes the synthetic cross-agent default thread even when it is pi", () => {
		const threads: HomeThread[] = [
			makeThread({ id: DEFAULT_HOME_THREAD_ID, agentId: "pi", isDefault: true }),
			makeThread({ id: "pi-1", agentId: "pi" }),
		];
		const sessions = derivePiSessions(threads);
		expect(sessions.map((s) => s.id)).toEqual(["pi-1"]);
	});

	it("is empty until the user creates a pi session (no default/base presented)", () => {
		expect(derivePiSessions([])).toEqual([]);
		expect(derivePiSessions([makeThread({ id: "claude-1", agentId: "claude" })])).toEqual([]);
		expect(
			derivePiSessions([makeThread({ id: DEFAULT_HOME_THREAD_ID, agentId: "pi", isDefault: true })]),
		).toEqual([]);
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
		expect(resolveActivePiSessionId([], "pi-1")).toBeNull();
		expect(resolveActivePiSessionId([], null)).toBeNull();
	});
});

describe("nextActivePiSessionAfterClose", () => {
	it("drops the active selection when the closed session was active", () => {
		expect(nextActivePiSessionAfterClose("pi-1", "pi-1")).toBeNull();
	});

	it("keeps the current selection when a non-active session is closed", () => {
		expect(nextActivePiSessionAfterClose("pi-2", "pi-1")).toBe("pi-1");
	});

	it("tolerates a null active selection", () => {
		expect(nextActivePiSessionAfterClose("pi-1", null)).toBeNull();
	});
});
