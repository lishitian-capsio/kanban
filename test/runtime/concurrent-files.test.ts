import pLimit from "p-limit";
import { describe, expect, it } from "vitest";

import { mapWithLimit, resolveFileConcurrency } from "../../src/fs/concurrent-files";

function deferredDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("resolveFileConcurrency", () => {
	it("defaults to a positive bound when the env value is absent or invalid", () => {
		expect(resolveFileConcurrency(undefined)).toBeGreaterThan(0);
		expect(resolveFileConcurrency("")).toBeGreaterThan(0);
		expect(resolveFileConcurrency("not-a-number")).toBeGreaterThan(0);
		expect(resolveFileConcurrency("0")).toBeGreaterThan(0);
		expect(resolveFileConcurrency("-5")).toBeGreaterThan(0);
	});

	it("honors an explicit positive bound", () => {
		expect(resolveFileConcurrency("8")).toBe(8);
		expect(resolveFileConcurrency("128")).toBe(128);
	});
});

describe("mapWithLimit", () => {
	it("never runs more than `limit` tasks concurrently", async () => {
		const limit = pLimit(4);
		let inFlight = 0;
		let peak = 0;
		const items = Array.from({ length: 200 }, (_, index) => index);

		await mapWithLimit(items, limit, async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await deferredDelay(1);
			inFlight -= 1;
		});

		expect(peak).toBeLessThanOrEqual(4);
	});

	it("shares a single budget across concurrent fan-outs (board + reqs + vault)", async () => {
		// The real crash: loadWorkspaceState fans out board tasks, requirements and
		// vault docs at the same time. A shared limiter must bound their COMBINED
		// in-flight file opens, not just each fan-out in isolation.
		const limit = pLimit(4);
		let inFlight = 0;
		let peak = 0;
		const work = async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await deferredDelay(1);
			inFlight -= 1;
		};
		const batch = (count: number) =>
			mapWithLimit(
				Array.from({ length: count }, (_, index) => index),
				limit,
				work,
			);

		await Promise.all([batch(100), batch(100), batch(100)]);

		expect(peak).toBeLessThanOrEqual(4);
	});

	it("returns results in input order regardless of completion order", async () => {
		const limit = pLimit(8);
		const items = [50, 5, 30, 1, 20];

		const results = await mapWithLimit(items, limit, async (value) => {
			await deferredDelay(value % 7);
			return value * 2;
		});

		expect(results).toEqual([100, 10, 60, 2, 40]);
	});

	it("returns an empty array for empty input", async () => {
		const limit = pLimit(4);
		expect(await mapWithLimit([], limit, async () => 1)).toEqual([]);
	});

	it("propagates the first error", async () => {
		const limit = pLimit(2);
		await expect(
			mapWithLimit([1, 2, 3], limit, async (value) => {
				if (value === 2) {
					throw new Error("boom");
				}
				return value;
			}),
		).rejects.toThrow("boom");
	});
});
