import { describe, expect, it } from "vitest";

import type { RuntimeRequirementItem, RuntimeRequirementsData, RuntimeRequirementVersionsData } from "../../src/core/api-contract";
import {
	analyzeRequirements,
	applyReviewPlan,
	reviewPlanSchema,
} from "../../src/core/requirement-review";

const DAY_MS = 86_400_000;

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

function dataOf(...items: RuntimeRequirementItem[]): RuntimeRequirementsData {
	return { items };
}

function emptyVersions(): RuntimeRequirementVersionsData {
	return { versions: [] };
}

let counter = 0;
function sequentialUuid(): string {
	counter += 1;
	return `generated-${counter}-aaaaaaaa`;
}

describe("analyzeRequirements", () => {
	const now = 100 * DAY_MS;

	it("flags an active requirement untouched beyond the stale threshold (gate 6)", () => {
		const packet = analyzeRequirements(
			dataOf(requirement({ id: "r1", status: "active", updatedAt: now - 40 * DAY_MS })),
			{ staleDays: 30, now },
		);
		const signal = packet.signals[0];
		expect(signal.stale).toBe(true);
		expect(signal.staleForDays).toBe(40);
		expect(packet.staleDays).toBe(30);
	});

	it("does not flag a fresh active requirement or a stale non-active one as stale", () => {
		const packet = analyzeRequirements(
			dataOf(
				requirement({ id: "fresh", status: "active", updatedAt: now - 5 * DAY_MS }),
				requirement({ id: "olddraft", status: "draft", updatedAt: now - 999 * DAY_MS }),
			),
			{ staleDays: 30, now },
		);
		expect(packet.signals.find((s) => s.id === "fresh")?.stale).toBe(false);
		expect(packet.signals.find((s) => s.id === "olddraft")?.stale).toBe(false);
	});

	it("flags vague descriptions and missing acceptance criteria (gate 3)", () => {
		const packet = analyzeRequirements(
			dataOf(
				requirement({ id: "vague", description: "too short" }),
				requirement({
					id: "qualified",
					description: "Users authenticate with phone. Acceptance: OTP valid for 5 minutes and rate limited.",
					priority: "high",
				}),
			),
			{ now },
		);
		const vague = packet.signals.find((s) => s.id === "vague");
		const qualified = packet.signals.find((s) => s.id === "qualified");
		expect(vague?.vagueDescription).toBe(true);
		expect(vague?.missingAcceptanceCriteria).toBe(true);
		expect(vague?.priorityIsDefault).toBe(true);
		expect(qualified?.vagueDescription).toBe(false);
		expect(qualified?.missingAcceptanceCriteria).toBe(false);
		expect(qualified?.priorityIsDefault).toBe(false);
	});

	it("reports gates 4 and 5 as skipped because task↔requirement linkage is absent", () => {
		const packet = analyzeRequirements(dataOf(requirement({ id: "r1" })), { now });
		expect(packet.skippedGates.map((g) => g.gate).sort()).toEqual([4, 5]);
		for (const skipped of packet.skippedGates) {
			expect(skipped.reason).toMatch(/linkage/i);
		}
		expect(packet.gateGuide.filter((g) => g.status === "skipped").map((g) => g.gate).sort()).toEqual([4, 5]);
	});

	it("uses a default stale threshold of 30 days", () => {
		const packet = analyzeRequirements(dataOf(requirement({ id: "r1" })), { now });
		expect(packet.staleDays).toBe(30);
	});
});

describe("reviewPlanSchema", () => {
	it("rejects an update action with no changed fields", () => {
		const result = reviewPlanSchema.safeParse({
			actions: [{ kind: "update", id: "r1", reason: "noop", changes: {} }],
		});
		expect(result.success).toBe(false);
	});

	it("rejects a merge whose survivor is also listed as a duplicate", () => {
		const result = reviewPlanSchema.safeParse({
			actions: [{ kind: "merge", survivorId: "r1", duplicateIds: ["r1"], reason: "bad" }],
		});
		expect(result.success).toBe(false);
	});

	it("rejects a split with no new requirements", () => {
		const result = reviewPlanSchema.safeParse({
			actions: [{ kind: "split", sourceId: "r1", reason: "x", newRequirements: [] }],
		});
		expect(result.success).toBe(false);
	});

	it("accepts a well-formed plan with every action kind", () => {
		const result = reviewPlanSchema.safeParse({
			actions: [
				{ kind: "update", id: "r1", reason: "qualify", changes: { description: "now precise" } },
				{ kind: "archive", id: "r2", reason: "stale" },
				{ kind: "merge", survivorId: "r3", duplicateIds: ["r4"], reason: "dup" },
				{ kind: "split", sourceId: "r5", reason: "mixed", newRequirements: [{ title: "Part A" }] },
				{ kind: "delete", id: "r6", reason: "obsolete" },
			],
		});
		expect(result.success).toBe(true);
	});
});

describe("applyReviewPlan", () => {
	const now = 5000;

	it("applies an update through the version history with source agent (gate 3)", () => {
		const result = applyReviewPlan(
			dataOf(requirement({ id: "r1", description: "vague" })),
			emptyVersions(),
			{ actions: [{ kind: "update", id: "r1", reason: "added acceptance criteria", changes: { description: "precise + acceptance criteria" } }] },
			{ randomUuid: sequentialUuid, now },
		);
		expect(result.data.items[0].description).toBe("precise + acceptance criteria");
		const version = result.versions.versions.at(-1);
		expect(version?.source).toBe("agent");
		expect(version?.changeKind).toBe("update");
		expect(version?.reason).toBe("added acceptance criteria");
		const report = result.report.actions[0];
		expect(report).toMatchObject({ kind: "update", requirementId: "r1", why: "added acceptance criteria", version: version?.version });
		expect(result.report.summary.update).toBe(1);
		expect(result.report.summary.versionsWritten).toBe(1);
	});

	it("archives via a dedicated action (gate 6)", () => {
		const result = applyReviewPlan(
			dataOf(requirement({ id: "r1", status: "active" })),
			emptyVersions(),
			{ actions: [{ kind: "archive", id: "r1", reason: "stale 60d" }] },
			{ randomUuid: sequentialUuid, now },
		);
		expect(result.data.items[0].status).toBe("archived");
		expect(result.versions.versions.at(-1)?.source).toBe("agent");
		expect(result.report.summary.archive).toBe(1);
	});

	it("merges duplicates into a survivor, deleting the duplicates (gate 1)", () => {
		const result = applyReviewPlan(
			dataOf(
				requirement({ id: "survivor", description: "keep" }),
				requirement({ id: "dup1" }),
				requirement({ id: "dup2" }),
			),
			emptyVersions(),
			{
				actions: [
					{
						kind: "merge",
						survivorId: "survivor",
						duplicateIds: ["dup1", "dup2"],
						reason: "dup1/dup2 duplicate survivor",
						changes: { description: "merged" },
					},
				],
			},
			{ randomUuid: sequentialUuid, now },
		);
		expect(result.data.items.map((i) => i.id)).toEqual(["survivor"]);
		expect(result.data.items[0].description).toBe("merged");
		const deletes = result.versions.versions.filter((v) => v.changeKind === "delete");
		expect(deletes.map((v) => v.requirementId).sort()).toEqual(["dup1", "dup2"]);
		expect(deletes.every((v) => v.source === "agent")).toBe(true);
		const report = result.report.actions[0];
		expect(report).toMatchObject({ kind: "merge", survivorId: "survivor" });
		if (report.kind === "merge") {
			expect(report.deleted.map((d) => d.requirementId).sort()).toEqual(["dup1", "dup2"]);
			expect(typeof report.survivorVersion).toBe("number");
		}
		expect(result.report.summary.merge).toBe(1);
	});

	it("splits a requirement into new requirements (gate 2)", () => {
		const result = applyReviewPlan(
			dataOf(requirement({ id: "src", title: "Everything", description: "mixed" })),
			emptyVersions(),
			{
				actions: [
					{
						kind: "split",
						sourceId: "src",
						reason: "two intents",
						sourceChanges: { title: "Narrowed" },
						newRequirements: [
							{ title: "Intent A", priority: "high" },
							{ title: "Intent B" },
						],
					},
				],
			},
			{ randomUuid: sequentialUuid, now },
		);
		expect(result.data.items[0].title).toBe("Narrowed");
		expect(result.data.items).toHaveLength(3);
		const creates = result.versions.versions.filter((v) => v.changeKind === "create");
		expect(creates).toHaveLength(2);
		expect(creates.every((v) => v.source === "agent" && v.version === 1)).toBe(true);
		const report = result.report.actions[0];
		if (report.kind === "split") {
			expect(report.created).toHaveLength(2);
			expect(typeof report.sourceVersion).toBe("number");
		}
		expect(result.report.summary.split).toBe(1);
	});

	it("deletes a requirement and records the deletion version (agent)", () => {
		const result = applyReviewPlan(
			dataOf(requirement({ id: "r1" })),
			emptyVersions(),
			{ actions: [{ kind: "delete", id: "r1", reason: "obsolete" }] },
			{ randomUuid: sequentialUuid, now },
		);
		expect(result.data.items).toHaveLength(0);
		expect(result.versions.versions.at(-1)).toMatchObject({ changeKind: "delete", source: "agent", reason: "obsolete" });
		expect(result.report.summary.delete).toBe(1);
	});

	it("throws on an unknown requirement id so the whole plan is atomic", () => {
		expect(() =>
			applyReviewPlan(
				dataOf(requirement({ id: "r1" })),
				emptyVersions(),
				{ actions: [{ kind: "update", id: "missing", reason: "x", changes: { status: "done" } }] },
				{ randomUuid: sequentialUuid, now },
			),
		).toThrow(/missing/);
	});

	it("continues version numbering from existing history", () => {
		const seeded: RuntimeRequirementVersionsData = {
			versions: [
				{ requirementId: "r1", version: 1, changeKind: "create", snapshot: requirement({ id: "r1" }), source: "human", reason: null, createdAt: 1 },
			],
		};
		const result = applyReviewPlan(
			dataOf(requirement({ id: "r1" })),
			seeded,
			{ actions: [{ kind: "update", id: "r1", reason: "qualify", changes: { priority: "high" } }] },
			{ randomUuid: sequentialUuid, now },
		);
		expect(result.versions.versions.at(-1)?.version).toBe(2);
	});
});
