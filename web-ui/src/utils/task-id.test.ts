import { describe, expect, it } from "vitest";

import { formatTaskIdChipLabel, TASK_ID_CHIP_MAX_CHARS } from "@/utils/task-id";

describe("formatTaskIdChipLabel", () => {
	it("returns short ids unchanged", () => {
		expect(formatTaskIdChipLabel("0a42e")).toBe("0a42e");
		expect(formatTaskIdChipLabel("1a38f7c1")).toBe("1a38f7c1");
	});

	it("trims surrounding whitespace", () => {
		expect(formatTaskIdChipLabel("  0a42e  ")).toBe("0a42e");
	});

	it("keeps ids at the cap boundary in full", () => {
		const atCap = "a".repeat(TASK_ID_CHIP_MAX_CHARS);
		expect(formatTaskIdChipLabel(atCap)).toBe(atCap);
	});

	it("collapses the tail of an unexpectedly long id with an ellipsis", () => {
		const long = "0123456789abcdef";
		const label = formatTaskIdChipLabel(long, 6);
		expect(label).toBe("01234…");
		expect(label.length).toBe(6);
	});

	it("returns the raw id when the cap is non-positive", () => {
		expect(formatTaskIdChipLabel("0a42e", 0)).toBe("0a42e");
	});
});
