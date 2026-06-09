import { describe, expect, it } from "vitest";

import type { RuntimeRequirementsData } from "@/runtime/types";
import { addRequirement, deleteRequirement, sortRequirements, updateRequirement } from "@/state/requirements-state";

function emptyData(): RuntimeRequirementsData {
	return { items: [] };
}

describe("addRequirement", () => {
	it("creates a requirement with defaults and increasing order", () => {
		const first = addRequirement(emptyData(), { title: "  Phone login  " }, { now: 1000, uuid: () => "aaaaa111" });
		expect(first.requirement).toMatchObject({
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

		const second = addRequirement(
			first.data,
			{ title: "Dark mode", priority: "high", status: "active", description: "toggle" },
			{ now: 2000, uuid: () => "bbbbb222" },
		);
		expect(second.requirement.order).toBe(1);
		expect(second.requirement.priority).toBe("high");
		expect(second.data.items.map((item) => item.id)).toEqual(["aaaaa", "bbbbb"]);
	});

	it("throws on an empty title", () => {
		expect(() => addRequirement(emptyData(), { title: "   " })).toThrow(/title/i);
	});
});

describe("updateRequirement", () => {
	it("applies a partial patch and bumps updatedAt", () => {
		const created = addRequirement(emptyData(), { title: "A", description: "old" }, { now: 1000, uuid: () => "aaaaa1" });
		const updated = updateRequirement(created.data, "aaaaa", { description: "new", status: "done" }, 5000);
		expect(updated.updated).toBe(true);
		expect(updated.requirement).toMatchObject({ description: "new", status: "done", updatedAt: 5000, createdAt: 1000 });
	});

	it("returns updated:false for an unknown id", () => {
		const created = addRequirement(emptyData(), { title: "A" }, { now: 1000, uuid: () => "aaaaa1" });
		const updated = updateRequirement(created.data, "zzzzz", { title: "B" });
		expect(updated.updated).toBe(false);
		expect(updated.data).toBe(created.data);
	});
});

describe("deleteRequirement", () => {
	it("removes by id and reports removal", () => {
		const first = addRequirement(emptyData(), { title: "A" }, { now: 1, uuid: () => "aaaaa1" });
		const second = addRequirement(first.data, { title: "B" }, { now: 2, uuid: () => "bbbbb2" });
		const result = deleteRequirement(second.data, "aaaaa");
		expect(result.removed).toBe(true);
		expect(result.data.items.map((item) => item.id)).toEqual(["bbbbb"]);
	});

	it("returns removed:false for unknown id", () => {
		const first = addRequirement(emptyData(), { title: "A" }, { now: 1, uuid: () => "aaaaa1" });
		const result = deleteRequirement(first.data, "zzzzz");
		expect(result.removed).toBe(false);
		expect(result.data).toBe(first.data);
	});
});

describe("sortRequirements", () => {
	it("orders by `order` ascending", () => {
		const items = [
			{ id: "b", title: "B", description: "", priority: "medium", status: "draft", linkedTaskIds: [], order: 2, createdAt: 0, updatedAt: 0 },
			{ id: "a", title: "A", description: "", priority: "medium", status: "draft", linkedTaskIds: [], order: 1, createdAt: 0, updatedAt: 0 },
		] as RuntimeRequirementsData["items"];
		expect(sortRequirements(items).map((item) => item.id)).toEqual(["a", "b"]);
	});
});
