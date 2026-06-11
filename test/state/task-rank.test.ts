import { describe, expect, it } from "vitest";

import { reconcileColumnRanks } from "../../src/state/task-rank";

/** Sort the reconciled ids by their assigned rank string (the on-read ordering). */
function orderByRank(ranks: ReadonlyMap<string, string>): string[] {
	return [...ranks.entries()].sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id]) => id);
}

describe("reconcileColumnRanks", () => {
	it("returns an empty map for an empty column", () => {
		expect(reconcileColumnRanks([], new Map())).toEqual(new Map());
	});

	it("assigns strictly increasing ranks to a fresh column", () => {
		const ranks = reconcileColumnRanks(["a", "b", "c"], new Map());
		expect([...ranks.keys()].sort()).toEqual(["a", "b", "c"]);
		expect(orderByRank(ranks)).toEqual(["a", "b", "c"]);
		// Ranks are unique.
		expect(new Set(ranks.values()).size).toBe(3);
	});

	it("preserves every existing rank when the order is unchanged (no-op write)", () => {
		const existing = new Map([
			["a", "a0"],
			["b", "a1"],
			["c", "a2"],
		]);
		const ranks = reconcileColumnRanks(["a", "b", "c"], existing);
		expect(ranks).toEqual(existing);
	});

	it("keeps existing ranks and only mints a new one when appending", () => {
		const existing = new Map([
			["a", "a0"],
			["b", "a1"],
		]);
		const ranks = reconcileColumnRanks(["a", "b", "c"], existing);
		expect(ranks.get("a")).toBe("a0");
		expect(ranks.get("b")).toBe("a1");
		expect(ranks.get("c")).toBeDefined();
		// The appended task sorts last.
		expect(orderByRank(ranks)).toEqual(["a", "b", "c"]);
		const cRank = ranks.get("c");
		expect(cRank && cRank > "a1").toBe(true);
	});

	it("re-ranks only the moved task, leaving the rest byte-identical", () => {
		const existing = new Map([
			["a", "a0"],
			["b", "a1"],
			["c", "a2"],
		]);
		// Move "a" to the end: [b, c, a].
		const ranks = reconcileColumnRanks(["b", "c", "a"], existing);
		// The two un-moved tasks keep their exact rank strings -> their files don't change.
		expect(ranks.get("b")).toBe("a1");
		expect(ranks.get("c")).toBe("a2");
		// Only the moved task gets a fresh rank, and the order is honored.
		expect(orderByRank(ranks)).toEqual(["b", "c", "a"]);
		expect(ranks.get("a")).not.toBe("a0");
	});

	it("inserts a task between two existing ones without touching them", () => {
		const existing = new Map([
			["a", "a0"],
			["c", "a1"],
		]);
		const ranks = reconcileColumnRanks(["a", "b", "c"], existing);
		expect(ranks.get("a")).toBe("a0");
		expect(ranks.get("c")).toBe("a1");
		expect(orderByRank(ranks)).toEqual(["a", "b", "c"]);
	});

	it("drops ranks for tasks no longer present in the column", () => {
		const existing = new Map([
			["a", "a0"],
			["b", "a1"],
			["gone", "a2"],
		]);
		const ranks = reconcileColumnRanks(["a", "b"], existing);
		expect([...ranks.keys()].sort()).toEqual(["a", "b"]);
	});
});
