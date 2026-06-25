import { describe, expect, it } from "vitest";

import { computeCpuPercent, cpuUsageDeltaMicros } from "../../src/server/runtime-ops-metrics";

describe("cpuUsageDeltaMicros", () => {
	it("sums the user and system deltas between two samples", () => {
		const prev = { user: 1_000, system: 500 };
		const next = { user: 4_000, system: 2_500 };
		// (4000-1000) + (2500-500) = 3000 + 2000 = 5000
		expect(cpuUsageDeltaMicros(prev, next)).toBe(5_000);
	});

	it("returns zero when nothing changed", () => {
		const same = { user: 7_000, system: 3_000 };
		expect(cpuUsageDeltaMicros(same, same)).toBe(0);
	});
});

describe("computeCpuPercent", () => {
	it("is 100% when the process used a full core for the whole interval", () => {
		// 1000ms wall = 1_000_000µs; if CPU time equals wall time, that's one
		// fully-busy core → 100%.
		expect(computeCpuPercent({ cpuDeltaMicros: 1_000_000, elapsedMs: 1_000 })).toBe(100);
	});

	it("is 50% when the process used half a core's worth of time", () => {
		expect(computeCpuPercent({ cpuDeltaMicros: 500_000, elapsedMs: 1_000 })).toBe(50);
	});

	it("can exceed 100% across multiple cores (not clamped)", () => {
		// 3s of CPU time over a 1s interval = 300% (three busy cores).
		expect(computeCpuPercent({ cpuDeltaMicros: 3_000_000, elapsedMs: 1_000 })).toBe(300);
	});

	it("is 0% when the process was idle", () => {
		expect(computeCpuPercent({ cpuDeltaMicros: 0, elapsedMs: 2_500 })).toBe(0);
	});

	it("returns 0 for a non-positive elapsed interval instead of dividing by zero", () => {
		expect(computeCpuPercent({ cpuDeltaMicros: 1_000, elapsedMs: 0 })).toBe(0);
		expect(computeCpuPercent({ cpuDeltaMicros: 1_000, elapsedMs: -10 })).toBe(0);
	});

	it("never reports a negative percentage from a counter regression", () => {
		expect(computeCpuPercent({ cpuDeltaMicros: -5_000, elapsedMs: 1_000 })).toBe(0);
	});
});
