import { describe, expect, it } from "vitest";

import type { RuntimeRequirementsData } from "../../src/core/api-contract";
import { addRequirement, deleteRequirement, updateRequirement } from "../../src/core/requirement-mutations";

function emptyData(): RuntimeRequirementsData {
	return { items: [] };
}

describe("addRequirement", () => {
	it("creates a requirement with defaults and an ordered position", () => {
		const result = addRequirement(emptyData(), { title: "Phone login" }, () => "aaaaa111", 1000);

		expect(result.requirement).toMatchObject({
			id: "aaaaa",
			title: "Phone login",
			description: "",
			priority: "medium",
			status: "draft",
			linkedTaskIds: [],
			order: 0,
			createdAt: 1000,
			updatedAt: 1000,
		});
		expect(result.data.items).toHaveLength(1);
	});

	it("trims the title and rejects empty titles", () => {
		expect(() => addRequirement(emptyData(), { title: "   " }, () => "aaaaa111")).toThrow(/title/i);
	});

	it("assigns increasing order values and avoids id collisions", () => {
		const first = addRequirement(emptyData(), { title: "A" }, () => "aaaaa111", 1000);
		const second = addRequirement(
			first.data,
			{ title: "B", priority: "high", status: "active", description: "desc" },
			() => "bbbbb222",
			2000,
		);

		expect(second.requirement.order).toBe(1);
		expect(second.requirement.priority).toBe("high");
		expect(second.requirement.status).toBe("active");
		expect(second.requirement.description).toBe("desc");
		expect(second.data.items.map((item) => item.id)).toEqual(["aaaaa", "bbbbb"]);
	});
});

describe("updateRequirement", () => {
	it("applies a partial patch and bumps updatedAt", () => {
		const created = addRequirement(emptyData(), { title: "A", description: "old" }, () => "aaaaa111", 1000);

		const updated = updateRequirement(created.data, "aaaaa", { description: "new", priority: "urgent" }, 5000);

		expect(updated.updated).toBe(true);
		expect(updated.requirement).toMatchObject({
			id: "aaaaa",
			title: "A",
			description: "new",
			priority: "urgent",
			updatedAt: 5000,
			createdAt: 1000,
		});
	});

	it("returns updated:false for an unknown id", () => {
		const created = addRequirement(emptyData(), { title: "A" }, () => "aaaaa111", 1000);

		const updated = updateRequirement(created.data, "zzzzz", { title: "B" });

		expect(updated.updated).toBe(false);
		expect(updated.requirement).toBeNull();
		expect(updated.data).toBe(created.data);
	});

	it("rejects an empty title patch", () => {
		const created = addRequirement(emptyData(), { title: "A" }, () => "aaaaa111", 1000);

		expect(() => updateRequirement(created.data, "aaaaa", { title: "  " })).toThrow(/title/i);
	});
});

describe("deleteRequirement", () => {
	it("removes the requirement by id", () => {
		const first = addRequirement(emptyData(), { title: "A" }, () => "aaaaa111", 1000);
		const second = addRequirement(first.data, { title: "B" }, () => "bbbbb222", 2000);

		const result = deleteRequirement(second.data, "aaaaa");

		expect(result.deleted).toBe(true);
		expect(result.requirement?.id).toBe("aaaaa");
		expect(result.data.items.map((item) => item.id)).toEqual(["bbbbb"]);
	});

	it("returns deleted:false for an unknown id", () => {
		const first = addRequirement(emptyData(), { title: "A" }, () => "aaaaa111", 1000);

		const result = deleteRequirement(first.data, "zzzzz");

		expect(result.deleted).toBe(false);
		expect(result.requirement).toBeNull();
		expect(result.data).toBe(first.data);
	});
});
