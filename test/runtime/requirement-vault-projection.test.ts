import { describe, expect, it } from "vitest";

import type {
	RuntimeRequirementItem,
	RuntimeRequirementTaskLink,
	RuntimeVaultDocument,
} from "../../src/core/api-contract";
import {
	collectRelatedTasks,
	problemStatusToRequirementStatus,
	REQUIREMENT_DOC_TYPE,
	requirementItemToVaultImport,
	requirementStatusToProblemStatus,
	vaultDocumentToRequirementItem,
} from "../../src/state/requirement-vault-projection";

function item(overrides: Partial<RuntimeRequirementItem> = {}): RuntimeRequirementItem {
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

function vaultDoc(overrides: Partial<RuntimeVaultDocument> = {}): RuntimeVaultDocument {
	return {
		id: "req-1",
		type: REQUIREMENT_DOC_TYPE,
		title: "Phone login",
		body: "body text",
		frontmatter: { status: "proposed", priority: "high" },
		relativePath: ".kanban/files/docs/requirement/phone-login-req-1.md",
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

describe("requirement ↔ vault status maps", () => {
	it("maps delivery status to a PROBLEM state (active + done collapse to clarified)", () => {
		expect(requirementStatusToProblemStatus("draft")).toBe("proposed");
		expect(requirementStatusToProblemStatus("active")).toBe("clarified");
		expect(requirementStatusToProblemStatus("done")).toBe("clarified");
		expect(requirementStatusToProblemStatus("archived")).toBe("parked");
	});

	it("maps a PROBLEM state back onto the legacy enum (lossy reverse)", () => {
		expect(problemStatusToRequirementStatus("proposed")).toBe("draft");
		expect(problemStatusToRequirementStatus("clarified")).toBe("active");
		expect(problemStatusToRequirementStatus("parked")).toBe("archived");
		expect(problemStatusToRequirementStatus("invalid")).toBe("archived");
		// Unknown/garbage status degrades to draft rather than throwing.
		expect(problemStatusToRequirementStatus("nonsense")).toBe("draft");
	});
});

describe("collectRelatedTasks", () => {
	it("unions linkedTaskIds with link records, deduped and linkedTaskIds-first", () => {
		const links: RuntimeRequirementTaskLink[] = [
			{ requirementId: "req-1", taskId: "task-b", source: "human", createdAt: 1 },
			{ requirementId: "req-1", taskId: "task-a", source: "human", createdAt: 2 }, // dup of linkedTaskIds
			{ requirementId: "other", taskId: "task-z", source: "human", createdAt: 3 }, // different requirement
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

describe("vaultDocumentToRequirementItem", () => {
	it("projects a document back to the legacy item, applying the reverse status map and order", () => {
		const projected = vaultDocumentToRequirementItem(
			vaultDoc({ frontmatter: { status: "clarified", priority: "low", related_tasks: ["task-a", "task-b"] } }),
			3,
		);
		expect(projected).toEqual<RuntimeRequirementItem>({
			id: "req-1",
			title: "Phone login",
			description: "body text",
			priority: "low",
			status: "active",
			linkedTaskIds: ["task-a", "task-b"],
			order: 3,
			createdAt: 1000,
			updatedAt: 2000,
		});
	});

	it("falls back to a medium priority when the frontmatter value is missing or invalid", () => {
		expect(vaultDocumentToRequirementItem(vaultDoc({ frontmatter: {} }), 0).priority).toBe("medium");
		expect(vaultDocumentToRequirementItem(vaultDoc({ frontmatter: { priority: "bogus" } }), 0).priority).toBe(
			"medium",
		);
	});
});
