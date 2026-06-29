import { describe, expect, it } from "vitest";

import { planLruTerminalEvictions } from "@/terminal/persistent-terminal-lru";

function entry(key: string, isMounted = false): { key: string; isMounted: boolean } {
	return { key, isMounted };
}

describe("planLruTerminalEvictions", () => {
	it("evicts nothing while within the cap", () => {
		const entries = [entry("a"), entry("b"), entry("c")];
		expect(planLruTerminalEvictions(entries, "c", 5)).toEqual([]);
	});

	it("evicts the oldest docked terminals first until within the cap", () => {
		// Oldest → newest. Cap of 2 means evict the 2 oldest evictable ones.
		const entries = [entry("a"), entry("b"), entry("c"), entry("d")];
		expect(planLruTerminalEvictions(entries, "d", 2)).toEqual(["a", "b"]);
	});

	it("never evicts the just-ensured key, even when it is the oldest", () => {
		const entries = [entry("a"), entry("b"), entry("c")];
		// keepKey="a" is oldest but protected; evict the next oldest instead.
		expect(planLruTerminalEvictions(entries, "a", 2)).toEqual(["b"]);
	});

	it("never evicts a mounted (visible) terminal", () => {
		const entries = [entry("a", true), entry("b"), entry("c", true), entry("d")];
		// Cap 2, retained=4 → must drop 2, but only b and d are evictable.
		expect(planLruTerminalEvictions(entries, "d", 2)).toEqual(["b"]);
	});

	it("stops once the retained count is within the cap", () => {
		const entries = [entry("a"), entry("b"), entry("c"), entry("d"), entry("e")];
		// Cap 3, retained=5 → drop exactly the 2 oldest.
		expect(planLruTerminalEvictions(entries, "e", 3)).toEqual(["a", "b"]);
	});
});
