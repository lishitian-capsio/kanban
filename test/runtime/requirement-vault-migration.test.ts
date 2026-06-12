import { describe, expect, it } from "vitest";

import {
	collectRelatedTasks,
	type LegacyRequirementItem,
	type LegacyRequirementTaskLink,
	REQUIREMENT_DOC_TYPE,
	requirementItemToVaultImport,
	requirementStatusToProblemStatus,
} from "../../src/state/requirement-vault-migration";

function item(overrides: Partial<LegacyRequirementItem> = {}): LegacyRequirementItem {
	return {
		id: "req-1",
		title: "Phone login",
		description: "body text",
		priority: "high",
		status: "draft",
		linkedTaskIds: [],
		order: 0,
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

describe("requirement → vault status map", () => {
	it("maps delivery status to a PROBLEM state (active + done collapse to clarified)", () => {
		expect(requirementStatusToProblemStatus("draft")).toBe("proposed");
		expect(requirementStatusToProblemStatus("active")).toBe("clarified");
		expect(requirementStatusToProblemStatus("done")).toBe("clarified");
		expect(requirementStatusToProblemStatus("archived")).toBe("parked");
	});
});

describe("collectRelatedTasks", () => {
	it("unions linkedTaskIds with link records, deduped and linkedTaskIds-first", () => {
		const links: LegacyRequirementTaskLink[] = [
			{ requirementId: "req-1", taskId: "task-b", createdAt: 1 },
			{ requirementId: "req-1", taskId: "task-a", createdAt: 2 }, // dup of linkedTaskIds
			{ requirementId: "other", taskId: "task-z", createdAt: 3 }, // different requirement
		];
		expect(collectRelatedTasks(item({ linkedTaskIds: ["task-a"] }), links)).toEqual(["task-a", "task-b"]);
	});
});

describe("requirementItemToVaultImport", () => {
	it("moves description to the body, remaps status, and preserves id + timestamps", () => {
		const imported = requirementItemToVaultImport(item({ status: "done", priority: "urgent" }), ["task-a"]);
		expect(imported).toMatchObject({
			id: "req-1",
			type: REQUIREMENT_DOC_TYPE,
			title: "Phone login",
			body: "body text",
			createdAt: 1000,
			updatedAt: 2000,
			frontmatter: { status: "clarified", priority: "urgent", related_tasks: ["task-a"] },
		});
	});

	it("omits related_tasks when there are none", () => {
		const imported = requirementItemToVaultImport(item(), []);
		expect(imported.frontmatter?.related_tasks).toBeUndefined();
	});
});
