import { DEFAULT_HOME_THREAD_ID } from "@runtime-home-agent-session";
import { describe, expect, it } from "vitest";

import {
	buildPiBaseSession,
	derivePiSessions,
	nextActivePiSessionAfterClose,
	PI_AGENT_ID,
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

describe("buildPiBaseSession", () => {
	it("pins the base session to pi on the legacy default thread id", () => {
		const base = buildPiBaseSession();
		expect(base.id).toBe(DEFAULT_HOME_THREAD_ID);
		expect(base.agentId).toBe(PI_AGENT_ID);
		expect(base.isDefault).toBe(true);
	});
});

describe("derivePiSessions", () => {
	it("returns the base session first, then only created pi threads", () => {
		const threads: HomeThread[] = [
			makeThread({ id: DEFAULT_HOME_THREAD_ID, agentId: "claude", isDefault: true }),
			makeThread({ id: "pi-1", agentId: "pi" }),
			makeThread({ id: "claude-1", agentId: "claude" }),
			makeThread({ id: "pi-2", agentId: "pi" }),
		];
		const sessions = derivePiSessions(threads);
		expect(sessions.map((s) => s.id)).toEqual([DEFAULT_HOME_THREAD_ID, "pi-1", "pi-2"]);
		expect(sessions[0]?.isDefault).toBe(true);
		expect(sessions.every((s) => s.agentId === "pi")).toBe(true);
	});

	it("does not duplicate the base when the global default thread is itself pi", () => {
		const threads: HomeThread[] = [
			makeThread({ id: DEFAULT_HOME_THREAD_ID, agentId: "pi", isDefault: true }),
			makeThread({ id: "pi-1", agentId: "pi" }),
		];
		const sessions = derivePiSessions(threads);
		expect(sessions.map((s) => s.id)).toEqual([DEFAULT_HOME_THREAD_ID, "pi-1"]);
	});

	it("yields just the base when there are no created pi threads", () => {
		const sessions = derivePiSessions([makeThread({ id: "claude-1", agentId: "claude" })]);
		expect(sessions.map((s) => s.id)).toEqual([DEFAULT_HOME_THREAD_ID]);
	});
});

describe("resolveActivePiSessionId", () => {
	const sessions = derivePiSessions([makeThread({ id: "pi-1", agentId: "pi" })]);

	it("keeps a requested id that still exists", () => {
		expect(resolveActivePiSessionId(sessions, "pi-1")).toBe("pi-1");
	});

	it("falls back to the first (base) session when the requested id is gone", () => {
		expect(resolveActivePiSessionId(sessions, "pi-gone")).toBe(DEFAULT_HOME_THREAD_ID);
	});

	it("falls back to the first (base) session when nothing is requested", () => {
		expect(resolveActivePiSessionId(sessions, null)).toBe(DEFAULT_HOME_THREAD_ID);
	});
});

describe("nextActivePiSessionAfterClose", () => {
	it("falls back to the base when the closed session was active", () => {
		expect(nextActivePiSessionAfterClose("pi-1", "pi-1")).toBe(DEFAULT_HOME_THREAD_ID);
	});

	it("keeps the current selection when a non-active session is closed", () => {
		expect(nextActivePiSessionAfterClose("pi-2", "pi-1")).toBe("pi-1");
	});
});
