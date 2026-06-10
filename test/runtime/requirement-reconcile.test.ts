import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumn,
	RuntimeBoardData,
	RuntimeRequirementItem,
	RuntimeRequirementsData,
	RuntimeRequirementTaskLink,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementVersionsData,
} from "../../src/core/api-contract";
import { analyzeReconcile, applyReconcilePlan, reconcilePlanSchema } from "../../src/core/requirement-reconcile";

function card(overrides: Partial<RuntimeBoardCard> & { id: string }): RuntimeBoardCard {
	const { id, ...rest } = overrides;
	return {
		id,
		title: rest.title ?? `Card ${id}`,
		prompt: rest.prompt ?? "do the thing",
		startInPlanMode: rest.startInPlanMode ?? false,
		baseRef: rest.baseRef ?? "main",
		createdAt: rest.createdAt ?? 0,
		updatedAt: rest.updatedAt ?? 0,
		...rest,
	};
}

function column(id: RuntimeBoardColumn["id"], title: string, cards: RuntimeBoardCard[]): RuntimeBoardColumn {
	return { id, title, cards };
}

function boardOf(...columns: RuntimeBoardColumn[]): RuntimeBoardData {
	return { columns, dependencies: [] };
}

function requirement(overrides: Partial<RuntimeRequirementItem> & { id: string }): RuntimeRequirementItem {
	return {
		id: overrides.id,
		title: overrides.title ?? `Requirement ${overrides.id}`,
		description: overrides.description ?? "",
		priority: overrides.priority ?? "medium",
		status: overrides.status ?? "draft",
		linkedTaskIds: overrides.linkedTaskIds ?? [],
		order: overrides.order ?? 0,
		createdAt: overrides.createdAt ?? 0,
		updatedAt: overrides.updatedAt ?? 0,
	};
}

function requirementsOf(...items: RuntimeRequirementItem[]): RuntimeRequirementsData {
	return { items };
}

function link(
	overrides: Partial<RuntimeRequirementTaskLink> & { requirementId: string; taskId: string },
): RuntimeRequirementTaskLink {
	return {
		requirementId: overrides.requirementId,
		taskId: overrides.taskId,
		status: overrides.status ?? "proposed",
		source: overrides.source ?? "agent",
		createdAt: overrides.createdAt ?? 0,
	};
}

function linksOf(...links: RuntimeRequirementTaskLink[]): RuntimeRequirementTaskLinksData {
	return { links };
}

function emptyVersions(): RuntimeRequirementVersionsData {
	return { versions: [] };
}

describe("analyzeReconcile", () => {
	it("reports cards with no link at all as orphans, across columns", () => {
		const board = boardOf(
			column("backlog", "Backlog", [card({ id: "card-1", title: "Auth flow", prompt: "build login" })]),
			column("in_progress", "In Progress", [card({ id: "card-2" })]),
		);
		const packet = analyzeReconcile(board, requirementsOf(requirement({ id: "req-1" })), linksOf());

		expect(packet.orphanTasks).toEqual([
			{ taskId: "card-1", title: "Auth flow", prompt: "build login", columnId: "backlog", columnTitle: "Backlog" },
			{
				taskId: "card-2",
				title: "Card card-2",
				prompt: "do the thing",
				columnId: "in_progress",
				columnTitle: "In Progress",
			},
		]);
		expect(packet.requirementCatalog).toEqual([
			{ id: "req-1", title: "Requirement req-1", description: "", status: "draft", priority: "medium" },
		]);
		expect(packet.pendingProposed).toEqual([]);
	});

	it("excludes a card with a confirmed link from orphans", () => {
		const board = boardOf(column("backlog", "Backlog", [card({ id: "card-1" }), card({ id: "card-2" })]));
		const links = linksOf(link({ requirementId: "req-1", taskId: "card-1", status: "confirmed", source: "human" }));
		const packet = analyzeReconcile(board, requirementsOf(requirement({ id: "req-1" })), links);

		expect(packet.orphanTasks.map((t) => t.taskId)).toEqual(["card-2"]);
		expect(packet.pendingProposed).toEqual([]);
	});

	it("excludes a card with a proposed link from orphans and reports it under pendingProposed", () => {
		const board = boardOf(column("backlog", "Backlog", [card({ id: "card-1" }), card({ id: "card-2" })]));
		const links = linksOf(link({ requirementId: "req-1", taskId: "card-1", status: "proposed", source: "agent" }));
		const packet = analyzeReconcile(board, requirementsOf(requirement({ id: "req-1" })), links);

		expect(packet.orphanTasks.map((t) => t.taskId)).toEqual(["card-2"]);
		expect(packet.pendingProposed).toEqual([{ taskId: "card-1", requirementId: "req-1" }]);
	});

	it("returns empty arrays for an empty board and no requirements", () => {
		const packet = analyzeReconcile(boardOf(), requirementsOf(), linksOf());
		expect(packet).toEqual({ orphanTasks: [], requirementCatalog: [], pendingProposed: [] });
	});
});

describe("reconcilePlanSchema", () => {
	it("accepts a valid link entry", () => {
		const parsed = reconcilePlanSchema.safeParse({
			entries: [{ action: "link", taskId: "card-1", requirementId: "req-1", reason: "matches req-1" }],
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts a valid create-draft entry", () => {
		const parsed = reconcilePlanSchema.safeParse({
			entries: [
				{
					action: "create-draft",
					taskId: "card-1",
					requirement: { title: "Offline sync", description: "...", priority: "high" },
					reason: "no requirement covers this",
				},
			],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects an unknown action", () => {
		const parsed = reconcilePlanSchema.safeParse({
			entries: [{ action: "reassign", taskId: "card-1", requirementId: "req-1", reason: "x" }],
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a create-draft entry that smuggles a status field", () => {
		const parsed = reconcilePlanSchema.safeParse({
			entries: [
				{
					action: "create-draft",
					taskId: "card-1",
					requirement: { title: "X", status: "active" },
					reason: "x",
				},
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an empty entries array", () => {
		const parsed = reconcilePlanSchema.safeParse({ entries: [] });
		expect(parsed.success).toBe(false);
	});

	it("rejects a link entry missing requirementId", () => {
		const parsed = reconcilePlanSchema.safeParse({
			entries: [{ action: "link", taskId: "card-1", reason: "x" }],
		});
		expect(parsed.success).toBe(false);
	});
});

describe("applyReconcilePlan", () => {
	const deps = { randomUuid: () => "new-req-id", now: 5000 };

	it("turns a link entry into a proposed agent link with one version", () => {
		const result = applyReconcilePlan(
			requirementsOf(requirement({ id: "req-1" })),
			linksOf(),
			emptyVersions(),
			{ entries: [{ action: "link", taskId: "card-1", requirementId: "req-1", reason: "matches" }] },
			deps,
		);

		expect(result.links.links).toEqual([
			{ requirementId: "req-1", taskId: "card-1", status: "proposed", source: "agent", createdAt: 5000 },
		]);
		expect(result.versions.versions).toHaveLength(1);
		expect(result.versions.versions[0]).toMatchObject({
			requirementId: "req-1",
			source: "agent",
			changeKind: "update",
		});
		expect(result.report.summary).toEqual({ link: 1, createDraft: 0, versionsWritten: 1 });
		expect(result.report.entries).toEqual([
			{ action: "link", taskId: "card-1", requirementId: "req-1", why: "matches" },
		]);
	});

	it("creates a draft requirement and proposes a link for create-draft, writing two versions", () => {
		// addRequirement uses createUniqueTaskId which strips hyphens and truncates to 5 chars,
		// so randomUuid "new-req-id" → "newre".
		const generatedId = "new-req-id".replaceAll("-", "").slice(0, 5); // "newre"
		const result = applyReconcilePlan(
			requirementsOf(),
			linksOf(),
			emptyVersions(),
			{
				entries: [
					{
						action: "create-draft",
						taskId: "card-1",
						requirement: { title: "Offline sync", description: "sync offline", priority: "high" },
						reason: "uncovered",
					},
				],
			},
			deps,
		);

		const created = result.requirements.items.find((item) => item.id === generatedId);
		expect(created).toMatchObject({
			title: "Offline sync",
			description: "sync offline",
			priority: "high",
			status: "draft",
		});
		expect(result.links.links).toEqual([
			{ requirementId: generatedId, taskId: "card-1", status: "proposed", source: "agent", createdAt: 5000 },
		]);
		const versions = result.versions.versions.filter((v) => v.requirementId === generatedId);
		expect(versions.map((v) => v.changeKind)).toEqual(["create", "update"]);
		expect(versions.every((v) => v.source === "agent")).toBe(true);
		expect(result.report.summary).toEqual({ link: 0, createDraft: 1, versionsWritten: 2 });
		expect(result.report.entries).toEqual([
			{ action: "create-draft", taskId: "card-1", requirementId: generatedId, why: "uncovered" },
		]);
	});

	it("threads state across multiple entries", () => {
		let counter = 0;
		const result = applyReconcilePlan(
			requirementsOf(requirement({ id: "req-1" })),
			linksOf(),
			emptyVersions(),
			{
				entries: [
					{ action: "link", taskId: "card-1", requirementId: "req-1", reason: "a" },
					{ action: "create-draft", taskId: "card-2", requirement: { title: "New thing" }, reason: "b" },
				],
			},
			{ randomUuid: () => `gen-${++counter}`, now: 7000 },
		);

		expect(result.links.links.map((l) => l.taskId).sort()).toEqual(["card-1", "card-2"]);
		expect(result.report.summary).toEqual({ link: 1, createDraft: 1, versionsWritten: 3 });
	});

	it("throws when a link entry targets a missing requirement", () => {
		expect(() =>
			applyReconcilePlan(
				requirementsOf(),
				linksOf(),
				emptyVersions(),
				{ entries: [{ action: "link", taskId: "card-1", requirementId: "missing", reason: "x" }] },
				deps,
			),
		).toThrow(/not found/i);
	});

	it("throws when a link entry duplicates an existing link for the same pair", () => {
		const result = applyReconcilePlan(
			requirementsOf(requirement({ id: "req-1" })),
			linksOf(),
			emptyVersions(),
			{ entries: [{ action: "link", taskId: "card-1", requirementId: "req-1", reason: "first" }] },
			deps,
		);
		expect(() =>
			applyReconcilePlan(
				result.requirements,
				result.links,
				result.versions,
				{ entries: [{ action: "link", taskId: "card-1", requirementId: "req-1", reason: "again" }] },
				deps,
			),
		).toThrow(/already/i);
	});
});
