import { describe, expect, it } from "vitest";

import type {
	RuntimeRequirementItem,
	RuntimeRequirementsData,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementVersionsData,
} from "../../src/core/api-contract";
import { linkTask, unlink } from "../../src/core/requirement-task-link-mutations";
import { listRequirementVersions } from "../../src/core/requirement-versions";

function makeItem(overrides: Partial<RuntimeRequirementItem> = {}): RuntimeRequirementItem {
	return {
		id: "req-1",
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

function seed(item: RuntimeRequirementItem = makeItem()): {
	requirements: RuntimeRequirementsData;
	links: RuntimeRequirementTaskLinksData;
	versions: RuntimeRequirementVersionsData;
} {
	return {
		requirements: { items: [item] },
		links: { links: [] },
		versions: { versions: [] },
	};
}

describe("linkTask", () => {
	it("adds a link, mirrors it into linkedTaskIds, and records a version", () => {
		const { requirements, links, versions } = seed();

		const result = linkTask(requirements, links, versions, "req-1", "task-1", { source: "human", now: 3000 });

		expect(result.link).toEqual({
			requirementId: "req-1",
			taskId: "task-1",
			source: "human",
			createdAt: 3000,
		});
		expect(result.links.links).toHaveLength(1);
		expect(result.requirements.items[0]?.linkedTaskIds).toEqual(["task-1"]);
		expect(result.requirements.items[0]?.updatedAt).toBe(3000);

		const history = listRequirementVersions(result.versions, "req-1");
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ changeKind: "update", source: "human", version: 1 });
		expect(history[0]?.reason).toMatch(/link/i);
		expect(history[0]?.snapshot.linkedTaskIds).toEqual(["task-1"]);
	});

	it("throws when the requirement does not exist", () => {
		const { requirements, links, versions } = seed();
		expect(() => linkTask(requirements, links, versions, "missing", "task-1", { source: "human" })).toThrow(
			/not found/i,
		);
	});

	it("throws when a link for the pair already exists", () => {
		const { requirements, links, versions } = seed();
		const first = linkTask(requirements, links, versions, "req-1", "task-1", { source: "human", now: 2000 });
		expect(() =>
			linkTask(first.requirements, first.links, first.versions, "req-1", "task-1", { source: "human" }),
		).toThrow(/already/i);
	});
});

describe("unlink", () => {
	it("removes a link and strips it from linkedTaskIds", () => {
		const { requirements, links, versions } = seed();
		const linked = linkTask(requirements, links, versions, "req-1", "task-1", { source: "human", now: 3000 });

		const result = unlink(linked.requirements, linked.links, linked.versions, "req-1", "task-1", {
			source: "human",
			now: 5000,
		});

		expect(result.link).toMatchObject({ taskId: "task-1" });
		expect(result.links.links).toHaveLength(0);
		expect(result.requirements.items[0]?.linkedTaskIds).toEqual([]);
		expect(result.requirements.items[0]?.updatedAt).toBe(5000);

		const history = listRequirementVersions(result.versions, "req-1");
		expect(history.map((v) => v.version)).toEqual([1, 2]);
		expect(history[1]?.reason).toMatch(/unlink/i);
		expect(history[1]?.snapshot.linkedTaskIds).toEqual([]);
	});

	it("throws when no link exists for the pair", () => {
		const { requirements, links, versions } = seed();
		expect(() => unlink(requirements, links, versions, "req-1", "task-1", { source: "human" })).toThrow(/not found/i);
	});
});
