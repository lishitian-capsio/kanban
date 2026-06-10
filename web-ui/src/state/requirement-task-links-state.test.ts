import { describe, expect, it } from "vitest";

import type {
	RuntimeRequirementItem,
	RuntimeRequirementTaskLink,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementsData,
} from "@/runtime/types";
import type { BoardData } from "@/types";
import {
	confirmLink,
	reattachLink,
	rejectLink,
	selectPendingProposals,
} from "@/state/requirement-task-links-state";

function requirement(overrides: Partial<RuntimeRequirementItem> & { id: string }): RuntimeRequirementItem {
	return {
		id: overrides.id,
		title: overrides.title ?? `Req ${overrides.id}`,
		description: overrides.description ?? "",
		priority: overrides.priority ?? "medium",
		status: overrides.status ?? "active",
		linkedTaskIds: overrides.linkedTaskIds ?? [],
		order: overrides.order ?? 0,
		createdAt: overrides.createdAt ?? 1000,
		updatedAt: overrides.updatedAt ?? 1000,
	};
}

function link(overrides: Partial<RuntimeRequirementTaskLink> & { requirementId: string; taskId: string }): RuntimeRequirementTaskLink {
	return {
		requirementId: overrides.requirementId,
		taskId: overrides.taskId,
		status: overrides.status ?? "proposed",
		source: overrides.source ?? "agent",
		createdAt: overrides.createdAt ?? 1000,
	};
}

function board(cardIds: Array<{ id: string; title: string }>): BoardData {
	return {
		columns: [{ id: "backlog", title: "Backlog", cards: cardIds.map((c) => ({
			id: c.id,
			title: c.title,
			prompt: "",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1000,
			updatedAt: 1000,
		})) }],
		dependencies: [],
	};
}

describe("confirmLink", () => {
	it("flips the proposed link to confirmed and mirrors the task into linkedTaskIds", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [link({ requirementId: "r1", taskId: "t1" })] };
		const requirements: RuntimeRequirementsData = { items: [requirement({ id: "r1" })] };

		const result = confirmLink(links, requirements, "r1", "t1", 5000);

		expect(result.changed).toBe(true);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		expect(result.links.links[0]!.status).toBe("confirmed");
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		expect(result.requirements.items[0]!.linkedTaskIds).toEqual(["t1"]);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		expect(result.requirements.items[0]!.updatedAt).toBe(5000);
	});

	it("does not duplicate an already-present linkedTaskId", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [link({ requirementId: "r1", taskId: "t1" })] };
		const requirements: RuntimeRequirementsData = { items: [requirement({ id: "r1", linkedTaskIds: ["t1"] })] };

		const result = confirmLink(links, requirements, "r1", "t1", 5000);

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		expect(result.requirements.items[0]!.linkedTaskIds).toEqual(["t1"]);
	});

	it("returns changed=false when no matching proposed link exists", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [] };
		const requirements: RuntimeRequirementsData = { items: [requirement({ id: "r1" })] };

		const result = confirmLink(links, requirements, "r1", "t1", 5000);

		expect(result.changed).toBe(false);
		expect(result.links).toBe(links);
		expect(result.requirements).toBe(requirements);
	});
});

describe("rejectLink", () => {
	it("removes the proposed link and leaves no residue in linkedTaskIds", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [link({ requirementId: "r1", taskId: "t1" })] };
		const requirements: RuntimeRequirementsData = { items: [requirement({ id: "r1", linkedTaskIds: ["t1"] })] };

		const result = rejectLink(links, requirements, "r1", "t1");

		expect(result.changed).toBe(true);
		expect(result.links.links).toHaveLength(0);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		expect(result.requirements.items[0]!.linkedTaskIds).toEqual([]);
	});

	it("returns changed=false when no matching proposed link exists", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [] };
		const requirements: RuntimeRequirementsData = { items: [requirement({ id: "r1" })] };

		const result = rejectLink(links, requirements, "r1", "t1");

		expect(result.changed).toBe(false);
		expect(result.links).toBe(links);
		expect(result.requirements).toBe(requirements);
	});
});

describe("reattachLink", () => {
	it("moves a proposed link to another requirement", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [link({ requirementId: "r1", taskId: "t1" })] };

		const result = reattachLink(links, "r1", "t1", "r2");

		expect(result.changed).toBe(true);
		expect(result.links.links).toEqual([
			expect.objectContaining({ requirementId: "r2", taskId: "t1", status: "proposed" }),
		]);
	});

	it("collapses onto an existing link instead of duplicating", () => {
		const links: RuntimeRequirementTaskLinksData = {
			links: [link({ requirementId: "r1", taskId: "t1" }), link({ requirementId: "r2", taskId: "t1" })],
		};

		const result = reattachLink(links, "r1", "t1", "r2");

		expect(result.links.links).toHaveLength(1);
		expect(result.links.links[0]).toEqual(expect.objectContaining({ requirementId: "r2", taskId: "t1" }));
	});

	it("is a no-op when reattaching to the same requirement", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [link({ requirementId: "r1", taskId: "t1" })] };

		const result = reattachLink(links, "r1", "t1", "r1");

		expect(result.changed).toBe(false);
		expect(result.links).toBe(links);
	});
});

describe("selectPendingProposals", () => {
	it("buckets clean links, drafts, and inbox (dangling + draft-target)", () => {
		const requirements: RuntimeRequirementsData = {
			items: [
				requirement({ id: "r1", status: "active" }),
				requirement({ id: "r2", status: "draft" }),
			],
		};
		const links: RuntimeRequirementTaskLinksData = {
			links: [
				link({ requirementId: "r1", taskId: "t1" }), // clean
				link({ requirementId: "r2", taskId: "t1" }), // draft target -> inbox
				link({ requirementId: "r1", taskId: "missing" }), // dangling task -> inbox
				link({ requirementId: "gone", taskId: "t1" }), // dangling requirement -> inbox
				link({ requirementId: "r1", taskId: "t1", status: "confirmed" }), // ignored
			],
		};

		const result = selectPendingProposals(links, requirements, board([{ id: "t1", title: "Task One" }]));

		expect(result.links).toHaveLength(1);
		expect(result.links[0]).toMatchObject({ taskTitle: "Task One", requirement: expect.objectContaining({ id: "r1" }) });
		expect(result.drafts).toHaveLength(1);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		expect(result.drafts[0]!.requirement.id).toBe("r2");
		expect(result.inbox).toHaveLength(3);
	});

	it("resolves task titles across multiple columns", () => {
		const requirements: RuntimeRequirementsData = { items: [requirement({ id: "r1", status: "active" })] };
		const links: RuntimeRequirementTaskLinksData = { links: [link({ requirementId: "r1", taskId: "t2" })] };
		const multiColumnBoard: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{ id: "t2", title: "Second column task", prompt: "", startInPlanMode: false, baseRef: "main", createdAt: 1000, updatedAt: 1000 },
					],
				},
			],
			dependencies: [],
		};

		const result = selectPendingProposals(links, requirements, multiColumnBoard);

		expect(result.links).toHaveLength(1);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		expect(result.links[0]!.taskTitle).toBe("Second column task");
	});
});
