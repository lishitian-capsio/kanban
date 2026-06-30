import { DEFAULT_HOME_THREAD_ID } from "@runtime-home-agent-session";
import { describe, expect, it } from "vitest";

import {
	derivePiSessions,
	isPiSession,
	nextActivePiSessionAfterClose,
	resolvePiSessionSelection,
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
		expect(derivePiSessions([makeThread({ id: DEFAULT_HOME_THREAD_ID, agentId: "pi", isDefault: true })])).toEqual(
			[],
		);
	});
});

describe("isPiSession", () => {
	it("is true only for a created (non-default) pi thread", () => {
		expect(isPiSession(makeThread({ id: "pi-1", agentId: "pi" }))).toBe(true);
		expect(isPiSession(makeThread({ id: "claude-1", agentId: "claude" }))).toBe(false);
		expect(isPiSession(makeThread({ id: DEFAULT_HOME_THREAD_ID, agentId: "pi", isDefault: true }))).toBe(false);
	});
});

describe("resolvePiSessionSelection", () => {
	const sessions = derivePiSessions([makeThread({ id: "pi-1", agentId: "pi" })]);

	it("keeps a requested id that still exists", () => {
		expect(resolvePiSessionSelection(sessions, "pi-1")).toBe("pi-1");
	});

	it("returns null when the requested id is gone (so the surface shows its fallback)", () => {
		expect(resolvePiSessionSelection(sessions, "pi-gone")).toBeNull();
	});

	it("returns null when nothing is requested (no pi session forced into view)", () => {
		expect(resolvePiSessionSelection(sessions, null)).toBeNull();
	});

	it("returns null when there are no sessions", () => {
		expect(resolvePiSessionSelection([], "pi-1")).toBeNull();
		expect(resolvePiSessionSelection([], null)).toBeNull();
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
