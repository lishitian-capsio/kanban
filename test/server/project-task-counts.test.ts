import { describe, expect, it } from "vitest";
import type { RuntimeProjectTaskCounts } from "../../src/core/api-contract";
import { projectTaskCountsEqual, resolveFastProjectTaskCounts } from "../../src/server/workspace-registry";

const counts = (backlog: number, in_progress: number, review: number, trash: number): RuntimeProjectTaskCounts => ({
	backlog,
	in_progress,
	review,
	trash,
});

const EMPTY: RuntimeProjectTaskCounts = counts(0, 0, 0, 0);

describe("projectTaskCountsEqual", () => {
	it("treats identical counts as equal", () => {
		expect(
			projectTaskCountsEqual(
				{ backlog: 3, in_progress: 1, review: 2, trash: 0 },
				{ backlog: 3, in_progress: 1, review: 2, trash: 0 },
			),
		).toBe(true);
	});

	it("detects a difference in any single column", () => {
		const base = { backlog: 3, in_progress: 1, review: 2, trash: 0 };
		expect(projectTaskCountsEqual(base, { ...base, backlog: 4 })).toBe(false);
		expect(projectTaskCountsEqual(base, { ...base, in_progress: 0 })).toBe(false);
		expect(projectTaskCountsEqual(base, { ...base, review: 3 })).toBe(false);
		expect(projectTaskCountsEqual(base, { ...base, trash: 1 })).toBe(false);
	});
});

describe("resolveFastProjectTaskCounts (F-CONN-2 connect fast path)", () => {
	it("uses the freshly-read counts for the current project", () => {
		const current = counts(2, 1, 0, 3);
		const result = resolveFastProjectTaskCounts(["a", "b"], "a", current, new Map());
		expect(result.get("a")).toBe(current);
	});

	it("reuses last-known cached counts for non-current projects (no board read)", () => {
		const cachedB = counts(5, 0, 1, 0);
		const result = resolveFastProjectTaskCounts(["a", "b"], "a", counts(1, 0, 0, 0), new Map([["b", cachedB]]));
		expect(result.get("b")).toBe(cachedB);
	});

	it("falls back to empty counts for a non-current project never read on this process", () => {
		const result = resolveFastProjectTaskCounts(["a", "b"], "a", counts(1, 0, 0, 0), new Map());
		expect(result.get("b")).toEqual(EMPTY);
	});

	it("ignores currentCounts when there is no resolved current project (uses cache/empty)", () => {
		const cachedA = counts(4, 0, 0, 0);
		const result = resolveFastProjectTaskCounts(["a", "b"], null, counts(9, 9, 9, 9), new Map([["a", cachedA]]));
		expect(result.get("a")).toBe(cachedA);
		expect(result.get("b")).toEqual(EMPTY);
	});

	it("falls back to cache/empty for the current id when its fresh read is unavailable (null)", () => {
		const cachedA = counts(7, 0, 0, 0);
		const withCache = resolveFastProjectTaskCounts(["a"], "a", null, new Map([["a", cachedA]]));
		expect(withCache.get("a")).toBe(cachedA);
		const withoutCache = resolveFastProjectTaskCounts(["a"], "a", null, new Map());
		expect(withoutCache.get("a")).toEqual(EMPTY);
	});

	it("returns one entry per project id", () => {
		const result = resolveFastProjectTaskCounts(["a", "b", "c"], "b", counts(1, 1, 1, 1), new Map());
		expect([...result.keys()]).toEqual(["a", "b", "c"]);
	});
});
