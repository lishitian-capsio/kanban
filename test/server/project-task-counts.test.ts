import { describe, expect, it } from "vitest";
import { projectTaskCountsEqual } from "../../src/server/workspace-registry";

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
