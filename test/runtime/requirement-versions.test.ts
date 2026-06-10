import { describe, expect, it } from "vitest";

import type {
	RuntimeRequirementItem,
	RuntimeRequirementsData,
	RuntimeRequirementVersionsData,
} from "../../src/core/api-contract";
import {
	appendRequirementVersion,
	diffRequirementVersions,
	findRequirementVersion,
	formatRequirementVersionLabel,
	listRequirementVersions,
	nextRequirementVersionNumber,
	revertRequirementToVersion,
} from "../../src/core/requirement-versions";

function emptyVersions(): RuntimeRequirementVersionsData {
	return { versions: [] };
}

function makeItem(overrides: Partial<RuntimeRequirementItem> = {}): RuntimeRequirementItem {
	return {
		id: "aaaaa",
		title: "Phone login",
		description: "",
		priority: "medium",
		status: "draft",
		linkedTaskIds: [],
		order: 0,
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

describe("formatRequirementVersionLabel", () => {
	it("renders a version number in v1/v2 form", () => {
		expect(formatRequirementVersionLabel(1)).toBe("v1");
		expect(formatRequirementVersionLabel(2)).toBe("v2");
		expect(formatRequirementVersionLabel(42)).toBe("v42");
	});
});

describe("diffRequirementVersions", () => {
	it("appends a create version for a requirement that only exists in next", () => {
		const next: RuntimeRequirementsData = { items: [makeItem({ id: "aaaaa" })] };
		const result = diffRequirementVersions({ items: [] }, next, emptyVersions(), { source: "human", now: 5000 });
		const history = listRequirementVersions(result, "aaaaa");
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ version: 1, changeKind: "create", source: "human", createdAt: 5000 });
		expect(history[0]?.snapshot.title).toBe("Phone login");
	});

	it("appends an update version when a versioned field changes", () => {
		const previous: RuntimeRequirementsData = { items: [makeItem({ id: "aaaaa", title: "Old" })] };
		const seed = appendRequirementVersion(emptyVersions(), {
			requirementId: "aaaaa",
			snapshot: makeItem({ id: "aaaaa", title: "Old" }),
			changeKind: "create",
			source: "human",
			now: 1000,
		}).data;
		const next: RuntimeRequirementsData = { items: [makeItem({ id: "aaaaa", title: "New" })] };
		const result = diffRequirementVersions(previous, next, seed, { source: "human", now: 6000 });
		const history = listRequirementVersions(result, "aaaaa");
		expect(history.map((v) => v.version)).toEqual([1, 2]);
		expect(history[1]).toMatchObject({ version: 2, changeKind: "update", source: "human" });
		expect(history[1]?.snapshot.title).toBe("New");
	});

	it("does not append a version when no versioned field changes", () => {
		const item = makeItem({ id: "aaaaa", order: 0 });
		const seed = appendRequirementVersion(emptyVersions(), {
			requirementId: "aaaaa",
			snapshot: item,
			changeKind: "create",
			source: "human",
			now: 1000,
		}).data;
		// Only `order` and `updatedAt` change — those are not versioned fields.
		const next: RuntimeRequirementsData = { items: [makeItem({ id: "aaaaa", order: 3, updatedAt: 9999 })] };
		const result = diffRequirementVersions({ items: [item] }, next, seed, { source: "human", now: 6000 });
		expect(listRequirementVersions(result, "aaaaa").map((v) => v.version)).toEqual([1]);
	});

	it("appends a delete version for a requirement removed in next", () => {
		const item = makeItem({ id: "aaaaa" });
		const seed = appendRequirementVersion(emptyVersions(), {
			requirementId: "aaaaa",
			snapshot: item,
			changeKind: "create",
			source: "human",
			now: 1000,
		}).data;
		const result = diffRequirementVersions({ items: [item] }, { items: [] }, seed, { source: "human", now: 7000 });
		const history = listRequirementVersions(result, "aaaaa");
		expect(history.map((v) => v.version)).toEqual([1, 2]);
		expect(history[1]).toMatchObject({ version: 2, changeKind: "delete", source: "human" });
		expect(history[1]?.snapshot.title).toBe("Phone login");
	});

	it("handles create, update, and delete in a single diff with per-requirement numbering", () => {
		const kept = makeItem({ id: "aaaaa", title: "Kept" });
		const removed = makeItem({ id: "bbbbb", title: "Removed" });
		let seed = appendRequirementVersion(emptyVersions(), {
			requirementId: "aaaaa",
			snapshot: kept,
			changeKind: "create",
			source: "human",
			now: 1000,
		}).data;
		seed = appendRequirementVersion(seed, {
			requirementId: "bbbbb",
			snapshot: removed,
			changeKind: "create",
			source: "human",
			now: 1000,
		}).data;
		const previous: RuntimeRequirementsData = { items: [kept, removed] };
		const next: RuntimeRequirementsData = {
			items: [makeItem({ id: "aaaaa", title: "Kept edited" }), makeItem({ id: "ccccc", title: "Added" })],
		};
		const result = diffRequirementVersions(previous, next, seed, { source: "human", now: 8000 });
		expect(listRequirementVersions(result, "aaaaa").map((v) => v.changeKind)).toEqual(["create", "update"]);
		expect(listRequirementVersions(result, "bbbbb").map((v) => v.changeKind)).toEqual(["create", "delete"]);
		expect(listRequirementVersions(result, "ccccc").map((v) => ({ version: v.version, kind: v.changeKind }))).toEqual([
			{ version: 1, kind: "create" },
		]);
	});

	it("returns the same versions reference when nothing changed", () => {
		const item = makeItem({ id: "aaaaa" });
		const seed = appendRequirementVersion(emptyVersions(), {
			requirementId: "aaaaa",
			snapshot: item,
			changeKind: "create",
			source: "human",
			now: 1000,
		}).data;
		const result = diffRequirementVersions({ items: [item] }, { items: [item] }, seed, { source: "human", now: 9000 });
		expect(result).toBe(seed);
	});
});

describe("nextRequirementVersionNumber", () => {
	it("starts at 1 and increments per requirement id", () => {
		const empty = emptyVersions();
		expect(nextRequirementVersionNumber(empty, "aaaaa")).toBe(1);

		const after = appendRequirementVersion(empty, {
			requirementId: "aaaaa",
			snapshot: makeItem(),
			changeKind: "create",
			source: "human",
			now: 1000,
		}).data;
		expect(nextRequirementVersionNumber(after, "aaaaa")).toBe(2);
		expect(nextRequirementVersionNumber(after, "bbbbb")).toBe(1);
	});
});

describe("appendRequirementVersion", () => {
	it("appends a version with monotonic numbering and null default reason", () => {
		const first = appendRequirementVersion(emptyVersions(), {
			requirementId: "aaaaa",
			snapshot: makeItem(),
			changeKind: "create",
			source: "human",
			now: 1000,
		});
		expect(first.version).toMatchObject({
			requirementId: "aaaaa",
			version: 1,
			changeKind: "create",
			source: "human",
			reason: null,
			createdAt: 1000,
		});

		const second = appendRequirementVersion(first.data, {
			requirementId: "aaaaa",
			snapshot: makeItem({ title: "Phone login v2" }),
			changeKind: "update",
			source: "agent",
			reason: "tweaked",
			now: 2000,
		});
		expect(second.version.version).toBe(2);
		expect(second.version.reason).toBe("tweaked");
		expect(second.data.versions.map((v) => v.version)).toEqual([1, 2]);
	});
});

describe("listRequirementVersions", () => {
	it("filters by id and sorts by version ascending", () => {
		let data = emptyVersions();
		data = appendRequirementVersion(data, {
			requirementId: "bbbbb",
			snapshot: makeItem({ id: "bbbbb" }),
			changeKind: "create",
			source: "human",
			now: 1,
		}).data;
		data = appendRequirementVersion(data, {
			requirementId: "aaaaa",
			snapshot: makeItem(),
			changeKind: "create",
			source: "human",
			now: 2,
		}).data;
		data = appendRequirementVersion(data, {
			requirementId: "aaaaa",
			snapshot: makeItem(),
			changeKind: "update",
			source: "human",
			now: 3,
		}).data;

		expect(listRequirementVersions(data, "aaaaa").map((v) => v.version)).toEqual([1, 2]);
		expect(listRequirementVersions(data, "bbbbb").map((v) => v.version)).toEqual([1]);
		expect(listRequirementVersions(data, "zzzzz")).toEqual([]);
	});
});

describe("findRequirementVersion", () => {
	it("returns the matching version or null", () => {
		const data = appendRequirementVersion(emptyVersions(), {
			requirementId: "aaaaa",
			snapshot: makeItem(),
			changeKind: "create",
			source: "human",
			now: 1,
		}).data;
		expect(findRequirementVersion(data, "aaaaa", 1)?.changeKind).toBe("create");
		expect(findRequirementVersion(data, "aaaaa", 2)).toBeNull();
		expect(findRequirementVersion(data, "zzzzz", 1)).toBeNull();
	});
});

describe("revertRequirementToVersion", () => {
	function seed(): { data: RuntimeRequirementsData; versions: RuntimeRequirementVersionsData } {
		const v1 = appendRequirementVersion(emptyVersions(), {
			requirementId: "aaaaa",
			snapshot: makeItem({ title: "Original", priority: "low", status: "draft" }),
			changeKind: "create",
			source: "human",
			now: 1000,
		});
		const current = makeItem({ title: "Changed", priority: "urgent", status: "active", updatedAt: 2000 });
		const v2 = appendRequirementVersion(v1.data, {
			requirementId: "aaaaa",
			snapshot: current,
			changeKind: "update",
			source: "human",
			now: 2000,
		});
		return { data: { items: [current] }, versions: v2.data };
	}

	it("restores snapshot fields, preserves identity, and records a revert version", () => {
		const { data, versions } = seed();
		const result = revertRequirementToVersion(data, versions, "aaaaa", 1, { source: "human", now: 3000 });

		expect(result.requirement).toMatchObject({
			id: "aaaaa",
			title: "Original",
			priority: "low",
			status: "draft",
			createdAt: 1000,
			updatedAt: 3000,
		});
		expect(result.data.items[0]?.title).toBe("Original");

		const history = listRequirementVersions(result.versions, "aaaaa");
		expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
		expect(history[2]).toMatchObject({ changeKind: "revert", source: "human", reason: "Reverted to version 1" });
		expect(history[2]?.snapshot.title).toBe("Original");
	});

	it("throws when the requirement does not currently exist", () => {
		const { versions } = seed();
		expect(() =>
			revertRequirementToVersion({ items: [] }, versions, "aaaaa", 1, { source: "human", now: 3000 }),
		).toThrow(/not found/i);
	});

	it("throws when the target version does not exist", () => {
		const { data, versions } = seed();
		expect(() => revertRequirementToVersion(data, versions, "aaaaa", 99, { source: "human", now: 3000 })).toThrow(
			/version/i,
		);
	});
});
