import { describe, expect, it } from "vitest";

import {
	BREADCRUMB_MAX_CHARS,
	classifyStall,
	DEFAULT_STALL_THRESHOLD_MS,
	readBreadcrumb,
	STALL_WATCHDOG_SAB_INT32_LENGTH,
	WORKER_POLL_INTERVAL_MS,
	writeBreadcrumb,
} from "../../src/server/event-loop-stall-watchdog";

function makeView(): Int32Array {
	return new Int32Array(STALL_WATCHDOG_SAB_INT32_LENGTH);
}

describe("breadcrumb codec", () => {
	it("round-trips a breadcrumb string", () => {
		const view = makeView();
		writeBreadcrumb(view, "trpc:saveState task=abc123");
		expect(readBreadcrumb(view)).toBe("trpc:saveState task=abc123");
	});

	it("returns an empty string before anything is written", () => {
		expect(readBreadcrumb(makeView())).toBe("");
	});

	it("truncates to the max breadcrumb length", () => {
		const view = makeView();
		const long = "x".repeat(BREADCRUMB_MAX_CHARS + 50);
		writeBreadcrumb(view, long);
		expect(readBreadcrumb(view)).toBe("x".repeat(BREADCRUMB_MAX_CHARS));
	});

	it("overwrites a previous (longer) breadcrumb without trailing residue", () => {
		const view = makeView();
		writeBreadcrumb(view, "a-very-long-previous-operation-label");
		writeBreadcrumb(view, "short");
		expect(readBreadcrumb(view)).toBe("short");
	});

	it("does not overflow the shared buffer at exactly the max length", () => {
		const view = makeView();
		const exact = "y".repeat(BREADCRUMB_MAX_CHARS);
		writeBreadcrumb(view, exact);
		expect(readBreadcrumb(view)).toBe(exact);
		// Nothing was written past the reserved region.
		expect(view.length).toBe(STALL_WATCHDOG_SAB_INT32_LENGTH);
	});
});

describe("classifyStall", () => {
	it("does not report a stall below the threshold", () => {
		const result = classifyStall({
			consecutiveMissedPolls: 3,
			pollIntervalMs: WORKER_POLL_INTERVAL_MS,
			thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
		});
		// 3 * 500 = 1500ms < 3000ms
		expect(result.stalled).toBe(false);
		expect(result.stalledMs).toBe(1_500);
	});

	it("reports a stall once the missed polls cross the threshold", () => {
		const result = classifyStall({
			consecutiveMissedPolls: 6,
			pollIntervalMs: WORKER_POLL_INTERVAL_MS,
			thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
		});
		// 6 * 500 = 3000ms >= 3000ms
		expect(result.stalled).toBe(true);
		expect(result.stalledMs).toBe(3_000);
	});

	it("reports a stall exactly at the threshold boundary", () => {
		const result = classifyStall({ consecutiveMissedPolls: 1, pollIntervalMs: 1_000, thresholdMs: 1_000 });
		expect(result.stalled).toBe(true);
		expect(result.stalledMs).toBe(1_000);
	});
});
