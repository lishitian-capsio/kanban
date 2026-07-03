import { describe, expect, it } from "vitest";

import { computeVisibleChipCount } from "@/components/home-agent/thread-task-bar-overflow";

describe("computeVisibleChipCount", () => {
	const gap = 4;
	const overflow = 24;

	it("shows all chips before measurement (container width unknown)", () => {
		expect(computeVisibleChipCount([50, 50, 50], 0, gap, overflow)).toBe(3);
		expect(computeVisibleChipCount([50, 50], Number.NaN, gap, overflow)).toBe(2);
	});

	it("fits as many leading chips as the container allows, reserving the overflow button", () => {
		// widths+gaps: 50+4=54, 108, 162; +overflow(24) => 78, 132, 186.
		// container 140 fits two chips (132 <= 140) but not three (186 > 140).
		expect(computeVisibleChipCount([50, 50, 50], 140, gap, overflow)).toBe(2);
	});

	it("fits everything when the container is wide enough", () => {
		expect(computeVisibleChipCount([50, 50, 50], 1000, gap, overflow)).toBe(3);
	});

	it("returns 0 when not even one chip fits alongside the overflow button", () => {
		expect(computeVisibleChipCount([200], 100, gap, overflow)).toBe(0);
	});

	it("handles an empty chip list", () => {
		expect(computeVisibleChipCount([], 500, gap, overflow)).toBe(0);
	});
});
