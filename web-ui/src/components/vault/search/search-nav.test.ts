import { describe, expect, it } from "vitest";

import { nextSelectedIndex, resolveSearchNavAction } from "./search-nav";

describe("resolveSearchNavAction", () => {
	it("maps arrow keys to movement", () => {
		expect(resolveSearchNavAction("ArrowDown")).toBe("next");
		expect(resolveSearchNavAction("ArrowUp")).toBe("previous");
	});

	it("maps Enter to open and Escape to close", () => {
		expect(resolveSearchNavAction("Enter")).toBe("open");
		expect(resolveSearchNavAction("Escape")).toBe("close");
	});

	it("returns null for keys it does not handle", () => {
		expect(resolveSearchNavAction("a")).toBeNull();
		expect(resolveSearchNavAction("Tab")).toBeNull();
		expect(resolveSearchNavAction("Shift")).toBeNull();
	});
});

describe("nextSelectedIndex", () => {
	it("moves forward and backward within bounds", () => {
		expect(nextSelectedIndex(0, "next", 3)).toBe(1);
		expect(nextSelectedIndex(2, "previous", 3)).toBe(1);
	});

	it("wraps around at both ends", () => {
		expect(nextSelectedIndex(2, "next", 3)).toBe(0);
		expect(nextSelectedIndex(0, "previous", 3)).toBe(2);
	});

	it("clamps an out-of-range current index before moving", () => {
		expect(nextSelectedIndex(99, "next", 3)).toBe(0);
		expect(nextSelectedIndex(-5, "previous", 3)).toBe(2);
	});

	it("stays at 0 when the list is empty", () => {
		expect(nextSelectedIndex(0, "next", 0)).toBe(0);
		expect(nextSelectedIndex(0, "previous", 0)).toBe(0);
	});
});
