import { describe, expect, it } from "vitest";

import type { RuntimeFileItem } from "@/runtime/types";

import { FILE_CATEGORIES, formatFileSize, groupFilesByCategory } from "./file-meta";

function makeFile(overrides: Partial<RuntimeFileItem> & Pick<RuntimeFileItem, "id">): RuntimeFileItem {
	return {
		id: overrides.id,
		name: overrides.name ?? `${overrides.id}.bin`,
		mime: overrides.mime ?? "application/octet-stream",
		category: overrides.category ?? "other",
		size: overrides.size ?? 0,
		addedAt: overrides.addedAt ?? 0,
	};
}

describe("formatFileSize", () => {
	it("renders bytes as whole numbers and falls back to 0 B for non-positive sizes", () => {
		expect(formatFileSize(0)).toBe("0 B");
		expect(formatFileSize(-5)).toBe("0 B");
		expect(formatFileSize(500)).toBe("500 B");
	});

	it("scales into larger units with one decimal of precision", () => {
		expect(formatFileSize(1024)).toBe("1 KB");
		expect(formatFileSize(1536)).toBe("1.5 KB");
		expect(formatFileSize(1024 * 1024)).toBe("1 MB");
		expect(formatFileSize(5.5 * 1024 * 1024)).toBe("5.5 MB");
	});
});

describe("groupFilesByCategory", () => {
	it("orders groups by FILE_CATEGORIES and skips empty categories", () => {
		const files = [
			makeFile({ id: "a", category: "other" }),
			makeFile({ id: "b", category: "image" }),
			makeFile({ id: "c", category: "document" }),
		];
		const groups = groupFilesByCategory(files);
		expect(groups.map((group) => group.category)).toEqual(["image", "document", "other"]);
		// Every emitted category appears in the canonical order list.
		for (const group of groups) {
			expect(FILE_CATEGORIES).toContain(group.category);
		}
	});

	it("sorts files within a group newest-first, then by name", () => {
		const files = [
			makeFile({ id: "old", category: "image", name: "z.png", addedAt: 100 }),
			makeFile({ id: "new", category: "image", name: "a.png", addedAt: 200 }),
			makeFile({ id: "tie", category: "image", name: "a.png", addedAt: 200 }),
		];
		const groups = groupFilesByCategory(files);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.files.map((file) => file.id)).toEqual(["new", "tie", "old"]);
	});
});
