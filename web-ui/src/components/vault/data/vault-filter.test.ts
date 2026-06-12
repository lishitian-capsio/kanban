import { describe, expect, it } from "vitest";

import type { RuntimeVaultFilterGroup, RuntimeVaultSort } from "@/runtime/types";
import type { VaultDoc } from "./vault-doc-model";
import { applyVaultView, matchesFilterGroup, sortVaultDocs } from "./vault-filter";

function doc(overrides: Partial<VaultDoc> = {}): VaultDoc {
	return {
		id: overrides.id ?? "id-1",
		type: overrides.type ?? "requirement",
		name: overrides.name ?? "Untitled",
		frontmatter: overrides.frontmatter ?? {},
		body: overrides.body ?? "",
		relativePath: overrides.relativePath ?? "docs/requirement/untitled-id-1.md",
		createdAt: overrides.createdAt ?? 1_000,
		updatedAt: overrides.updatedAt ?? 2_000,
	};
}

describe("matchesFilterGroup — scalar operators", () => {
	const d = doc({
		type: "requirement",
		name: "Login rate limit",
		frontmatter: { status: "proposed", priority: "high", customer: "[[Acme]]" },
	});

	it("equals matches a frontmatter field case-insensitively", () => {
		expect(matchesFilterGroup(d, { all: [{ field: "status", op: "equals", value: "Proposed" }] })).toBe(true);
		expect(matchesFilterGroup(d, { all: [{ field: "status", op: "equals", value: "clarified" }] })).toBe(false);
	});

	it("not_equals inverts equals", () => {
		expect(matchesFilterGroup(d, { all: [{ field: "status", op: "not_equals", value: "clarified" }] })).toBe(true);
		expect(matchesFilterGroup(d, { all: [{ field: "status", op: "not_equals", value: "proposed" }] })).toBe(false);
	});

	it("contains / not_contains do substring matching on title", () => {
		expect(matchesFilterGroup(d, { all: [{ field: "title", op: "contains", value: "rate" }] })).toBe(true);
		expect(matchesFilterGroup(d, { all: [{ field: "title", op: "not_contains", value: "logout" }] })).toBe(true);
		expect(matchesFilterGroup(d, { all: [{ field: "title", op: "contains", value: "logout" }] })).toBe(false);
	});

	it("matches the built-in type field", () => {
		expect(matchesFilterGroup(d, { all: [{ field: "type", op: "equals", value: "requirement" }] })).toBe(true);
		expect(matchesFilterGroup(d, { all: [{ field: "type", op: "equals", value: "customer" }] })).toBe(false);
	});

	it("any_of / none_of test scalar membership in the value array", () => {
		expect(
			matchesFilterGroup(d, { all: [{ field: "status", op: "any_of", value: ["proposed", "clarified"] }] }),
		).toBe(true);
		expect(matchesFilterGroup(d, { all: [{ field: "status", op: "any_of", value: ["parked", "invalid"] }] })).toBe(
			false,
		);
		expect(matchesFilterGroup(d, { all: [{ field: "status", op: "none_of", value: ["parked", "invalid"] }] })).toBe(
			true,
		);
		expect(matchesFilterGroup(d, { all: [{ field: "status", op: "none_of", value: ["proposed"] }] })).toBe(false);
	});

	it("is_empty / is_not_empty test presence of a value", () => {
		expect(matchesFilterGroup(d, { all: [{ field: "assignee", op: "is_empty" }] })).toBe(true);
		expect(matchesFilterGroup(d, { all: [{ field: "status", op: "is_empty" }] })).toBe(false);
		expect(matchesFilterGroup(d, { all: [{ field: "status", op: "is_not_empty" }] })).toBe(true);
		expect(
			matchesFilterGroup(doc({ frontmatter: { status: "" } }), { all: [{ field: "status", op: "is_empty" }] }),
		).toBe(true);
	});
});

describe("matchesFilterGroup — array fields", () => {
	const d = doc({ frontmatter: { tags: ["backend", "security"] } });

	it("contains tests array membership", () => {
		expect(matchesFilterGroup(d, { all: [{ field: "tags", op: "contains", value: "security" }] })).toBe(true);
		expect(matchesFilterGroup(d, { all: [{ field: "tags", op: "contains", value: "frontend" }] })).toBe(false);
	});

	it("any_of / none_of intersect with the value array", () => {
		expect(matchesFilterGroup(d, { all: [{ field: "tags", op: "any_of", value: ["frontend", "security"] }] })).toBe(
			true,
		);
		expect(matchesFilterGroup(d, { all: [{ field: "tags", op: "none_of", value: ["frontend", "ui"] }] })).toBe(true);
		expect(matchesFilterGroup(d, { all: [{ field: "tags", op: "none_of", value: ["security"] }] })).toBe(false);
	});

	it("is_empty is true only for an empty array", () => {
		expect(matchesFilterGroup(doc({ frontmatter: { tags: [] } }), { all: [{ field: "tags", op: "is_empty" }] })).toBe(
			true,
		);
		expect(matchesFilterGroup(d, { all: [{ field: "tags", op: "is_empty" }] })).toBe(false);
	});
});

describe("matchesFilterGroup — date operators", () => {
	const d = doc({ updatedAt: Date.parse("2026-06-10T00:00:00Z") });

	it("before / after compare the built-in updated timestamp against a date string", () => {
		expect(matchesFilterGroup(d, { all: [{ field: "updated", op: "after", value: "2026-06-01" }] })).toBe(true);
		expect(matchesFilterGroup(d, { all: [{ field: "updated", op: "before", value: "2026-06-01" }] })).toBe(false);
		expect(matchesFilterGroup(d, { all: [{ field: "updated", op: "before", value: "2026-07-01" }] })).toBe(true);
	});

	it("compares a frontmatter date string field", () => {
		const dated = doc({ frontmatter: { due: "2026-06-10" } });
		expect(matchesFilterGroup(dated, { all: [{ field: "due", op: "after", value: "2026-06-01" }] })).toBe(true);
		expect(matchesFilterGroup(dated, { all: [{ field: "due", op: "before", value: "2026-06-01" }] })).toBe(false);
	});
});

describe("matchesFilterGroup — all / any nesting", () => {
	const d = doc({ name: "Login rate limit", frontmatter: { status: "proposed", priority: "high" } });

	it("all requires every node to match (AND)", () => {
		const group: RuntimeVaultFilterGroup = {
			all: [
				{ field: "status", op: "equals", value: "proposed" },
				{ field: "priority", op: "equals", value: "high" },
			],
		};
		expect(matchesFilterGroup(d, group)).toBe(true);
		expect(
			matchesFilterGroup(d, {
				all: [
					{ field: "status", op: "equals", value: "proposed" },
					{ field: "priority", op: "equals", value: "low" },
				],
			}),
		).toBe(false);
	});

	it("any requires at least one node to match (OR)", () => {
		const group: RuntimeVaultFilterGroup = {
			any: [
				{ field: "status", op: "equals", value: "clarified" },
				{ field: "priority", op: "equals", value: "high" },
			],
		};
		expect(matchesFilterGroup(d, group)).toBe(true);
		expect(
			matchesFilterGroup(d, {
				any: [
					{ field: "status", op: "equals", value: "clarified" },
					{ field: "priority", op: "equals", value: "low" },
				],
			}),
		).toBe(false);
	});

	it("nests groups (any inside all)", () => {
		const group: RuntimeVaultFilterGroup = {
			all: [
				{ field: "type", op: "equals", value: "requirement" },
				{
					any: [
						{ field: "priority", op: "equals", value: "high" },
						{ field: "priority", op: "equals", value: "urgent" },
					],
				},
			],
		};
		expect(matchesFilterGroup(d, group)).toBe(true);
		expect(matchesFilterGroup(doc({ frontmatter: { priority: "low" } }), group)).toBe(false);
	});

	it("an empty group matches everything", () => {
		expect(matchesFilterGroup(d, { all: [] })).toBe(true);
	});
});

describe("sortVaultDocs", () => {
	const a = doc({ id: "a", name: "Alpha", updatedAt: 300, frontmatter: { priority: "low" } });
	const b = doc({ id: "b", name: "Bravo", updatedAt: 100, frontmatter: { priority: "high" } });
	const c = doc({ id: "c", name: "Charlie", updatedAt: 200, frontmatter: { priority: "medium" } });

	it("sorts by the built-in updated field ascending and descending", () => {
		const asc: RuntimeVaultSort = { field: "updated", direction: "asc" };
		expect(sortVaultDocs([a, b, c], asc).map((d) => d.id)).toEqual(["b", "c", "a"]);
		expect(sortVaultDocs([a, b, c], { field: "updated", direction: "desc" }).map((d) => d.id)).toEqual([
			"a",
			"c",
			"b",
		]);
	});

	it("sorts by title alphabetically", () => {
		expect(sortVaultDocs([c, a, b], { field: "title", direction: "asc" }).map((d) => d.id)).toEqual(["a", "b", "c"]);
	});

	it("sorts by a frontmatter field alphabetically (no semantic ranking)", () => {
		// high < low < medium lexicographically, so asc yields b (high), a (low), c (medium).
		expect(sortVaultDocs([a, b, c], { field: "priority", direction: "asc" }).map((d) => d.id)).toEqual([
			"b",
			"a",
			"c",
		]);
	});

	it("does not mutate the input array", () => {
		const input = [a, b, c];
		sortVaultDocs(input, { field: "title", direction: "asc" });
		expect(input.map((d) => d.id)).toEqual(["a", "b", "c"]);
	});
});

describe("applyVaultView", () => {
	const a = doc({ id: "a", name: "Alpha", frontmatter: { status: "proposed" }, updatedAt: 300 });
	const b = doc({ id: "b", name: "Bravo", frontmatter: { status: "clarified" }, updatedAt: 100 });
	const c = doc({ id: "c", name: "Charlie", frontmatter: { status: "proposed" }, updatedAt: 200 });

	it("filters then sorts", () => {
		const result = applyVaultView([a, b, c], {
			filters: { all: [{ field: "status", op: "equals", value: "proposed" }] },
			sort: { field: "updated", direction: "asc" },
		});
		expect(result.map((d) => d.id)).toEqual(["c", "a"]);
	});

	it("returns all docs unsorted when no filter or sort is provided", () => {
		expect(applyVaultView([a, b, c], {}).map((d) => d.id)).toEqual(["a", "b", "c"]);
	});
});
