import { z } from "zod";

import {
	runtimeRequirementPrioritySchema,
	runtimeRequirementStatusSchema,
	type RuntimeRequirementItem,
	type RuntimeRequirementsData,
	type RuntimeRequirementVersionsData,
} from "./api-contract";
import { addRequirement, deleteRequirement, updateRequirement } from "./requirement-mutations";
import { appendRequirementVersion } from "./requirement-versions";

const DAY_MS = 86_400_000;
const DEFAULT_STALE_DAYS = 30;
const VAGUE_DESCRIPTION_MIN_LENGTH = 24;

// Markers that suggest a description carries acceptance criteria. Lower-cased before matching.
const ACCEPTANCE_CRITERIA_MARKERS = ["accept", "验收", "given", "when", "then", "criteria", "- [ ]", "- [x]"] as const;

const LINKAGE_SKIP_REASON =
	"task↔requirement linkage not implemented (board cards have no requirementId; linkedTaskIds is always empty)";

// ---------------------------------------------------------------------------
// Analyze (phase 1): read-only review packet for the agent to reason over.
// ---------------------------------------------------------------------------

export interface AnalyzeRequirementsOptions {
	staleDays?: number;
	now?: number;
}

export interface RequirementReviewSignal {
	id: string;
	title: string;
	status: RuntimeRequirementItem["status"];
	priority: RuntimeRequirementItem["priority"];
	/** gate 6: status is active and the item is older than the stale threshold. */
	stale: boolean;
	/** Age of the item in whole days since its last update. */
	staleForDays: number;
	/** gate 3: description is empty or very short. */
	vagueDescription: boolean;
	/** gate 3: description contains no recognizable acceptance-criteria markers. */
	missingAcceptanceCriteria: boolean;
	/** gate 3 hint: priority is still the schema default ("medium"); the agent decides. */
	priorityIsDefault: boolean;
}

export interface RequirementReviewSkippedGate {
	gate: number;
	name: string;
	reason: string;
}

export interface RequirementReviewGateGuideEntry {
	gate: number;
	name: string;
	description: string;
	status: "active" | "skipped";
}

export interface RequirementReviewPacket {
	staleDays: number;
	signals: RequirementReviewSignal[];
	skippedGates: RequirementReviewSkippedGate[];
	gateGuide: RequirementReviewGateGuideEntry[];
}

const SKIPPED_GATES: readonly RequirementReviewSkippedGate[] = [
	{ gate: 4, name: "orphan-or-finish", reason: LINKAGE_SKIP_REASON },
	{ gate: 5, name: "misassignment", reason: LINKAGE_SKIP_REASON },
];

const GATE_GUIDE: readonly RequirementReviewGateGuideEntry[] = [
	{ gate: 1, name: "duplicate", description: "Two requirements describe the same thing → merge them.", status: "active" },
	{ gate: 2, name: "too-broad", description: "One requirement mixes unrelated intents → split it.", status: "active" },
	{
		gate: 3,
		name: "unqualified",
		description: "Vague description / no acceptance criteria / unreviewed priority → qualify it.",
		status: "active",
	},
	{ gate: 4, name: "orphan-or-finish", description: LINKAGE_SKIP_REASON, status: "skipped" },
	{ gate: 5, name: "misassignment", description: LINKAGE_SKIP_REASON, status: "skipped" },
	{ gate: 6, name: "stale", description: "Active requirement untouched for a long time → archive or refresh.", status: "active" },
];

export function analyzeRequirements(
	data: RuntimeRequirementsData,
	options: AnalyzeRequirementsOptions = {},
): RequirementReviewPacket {
	const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
	const now = options.now ?? Date.now();
	const staleThresholdMs = staleDays * DAY_MS;

	const signals = data.items.map((item): RequirementReviewSignal => {
		const ageMs = Math.max(0, now - item.updatedAt);
		const description = item.description.trim();
		const lowered = description.toLowerCase();
		return {
			id: item.id,
			title: item.title,
			status: item.status,
			priority: item.priority,
			stale: item.status === "active" && ageMs >= staleThresholdMs,
			staleForDays: Math.floor(ageMs / DAY_MS),
			vagueDescription: description.length < VAGUE_DESCRIPTION_MIN_LENGTH,
			missingAcceptanceCriteria: !ACCEPTANCE_CRITERIA_MARKERS.some((marker) => lowered.includes(marker)),
			priorityIsDefault: item.priority === "medium",
		};
	});

	return {
		staleDays,
		signals,
		skippedGates: [...SKIPPED_GATES],
		gateGuide: [...GATE_GUIDE],
	};
}

// ---------------------------------------------------------------------------
// Apply (phase 2): execute an agent-decided action plan.
// ---------------------------------------------------------------------------

const requirementChangesSchema = z
	.object({
		title: z.string(),
		description: z.string(),
		priority: runtimeRequirementPrioritySchema,
		status: runtimeRequirementStatusSchema,
	})
	.partial()
	.strict();

const newRequirementSchema = z
	.object({
		title: z.string().min(1),
		description: z.string().optional(),
		priority: runtimeRequirementPrioritySchema.optional(),
		status: runtimeRequirementStatusSchema.optional(),
	})
	.strict();

const updateActionSchema = z
	.object({
		kind: z.literal("update"),
		id: z.string().min(1),
		reason: z.string().min(1),
		changes: requirementChangesSchema.refine((changes) => Object.values(changes).some((value) => value !== undefined), {
			message: "update.changes requires at least one field to change.",
		}),
	})
	.strict();

const archiveActionSchema = z
	.object({
		kind: z.literal("archive"),
		id: z.string().min(1),
		reason: z.string().min(1),
	})
	.strict();

const mergeActionSchema = z
	.object({
		kind: z.literal("merge"),
		survivorId: z.string().min(1),
		duplicateIds: z.array(z.string().min(1)).min(1),
		reason: z.string().min(1),
		changes: requirementChangesSchema.optional(),
	})
	.strict();

const splitActionSchema = z
	.object({
		kind: z.literal("split"),
		sourceId: z.string().min(1),
		reason: z.string().min(1),
		sourceChanges: requirementChangesSchema.optional(),
		newRequirements: z.array(newRequirementSchema).min(1),
	})
	.strict();

const deleteActionSchema = z
	.object({
		kind: z.literal("delete"),
		id: z.string().min(1),
		reason: z.string().min(1),
	})
	.strict();

export const reviewActionSchema = z.discriminatedUnion("kind", [
	updateActionSchema,
	archiveActionSchema,
	mergeActionSchema,
	splitActionSchema,
	deleteActionSchema,
]);
export type RequirementReviewAction = z.infer<typeof reviewActionSchema>;

export const reviewPlanSchema = z
	.object({
		actions: z.array(reviewActionSchema).min(1),
	})
	.strict()
	.superRefine((plan, ctx) => {
		plan.actions.forEach((action, index) => {
			if (action.kind !== "merge") {
				return;
			}
			if (action.duplicateIds.includes(action.survivorId)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "merge.survivorId must not also be listed in duplicateIds.",
					path: ["actions", index, "duplicateIds"],
				});
			}
			if (new Set(action.duplicateIds).size !== action.duplicateIds.length) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "merge.duplicateIds must be distinct.",
					path: ["actions", index, "duplicateIds"],
				});
			}
		});
	});
export type RequirementReviewPlan = z.infer<typeof reviewPlanSchema>;

export type RequirementReviewChanges = z.infer<typeof requirementChangesSchema>;

export interface ApplyReviewPlanDeps {
	randomUuid: () => string;
	now?: number;
}

export interface RequirementVersionRef {
	requirementId: string;
	version: number;
}

export type RequirementReviewActionReport =
	| { kind: "update"; requirementId: string; what: string; why: string; version: number }
	| { kind: "archive"; requirementId: string; what: string; why: string; version: number }
	| { kind: "merge"; survivorId: string; what: string; why: string; survivorVersion: number | null; deleted: RequirementVersionRef[] }
	| { kind: "split"; sourceId: string; what: string; why: string; sourceVersion: number | null; created: RequirementVersionRef[] }
	| { kind: "delete"; requirementId: string; what: string; why: string; version: number };

export interface RequirementReviewSummary {
	update: number;
	archive: number;
	merge: number;
	split: number;
	delete: number;
	versionsWritten: number;
}

export interface RequirementReviewReport {
	actions: RequirementReviewActionReport[];
	summary: RequirementReviewSummary;
}

export interface ApplyReviewResult {
	data: RuntimeRequirementsData;
	versions: RuntimeRequirementVersionsData;
	report: RequirementReviewReport;
}

function describeChanges(changes: RequirementReviewChanges): string {
	const fields = Object.entries(changes)
		.filter(([, value]) => value !== undefined)
		.map(([key]) => key);
	return fields.length > 0 ? `updated ${fields.join(", ")}` : "no field changes";
}

export function applyReviewPlan(
	requirements: RuntimeRequirementsData,
	versions: RuntimeRequirementVersionsData,
	plan: RequirementReviewPlan,
	deps: ApplyReviewPlanDeps,
): ApplyReviewResult {
	const now = deps.now ?? Date.now();
	let data = requirements;
	let versionData = versions;
	const actions: RequirementReviewActionReport[] = [];
	const summary: RequirementReviewSummary = { update: 0, archive: 0, merge: 0, split: 0, delete: 0, versionsWritten: 0 };

	const recordVersion = (
		snapshot: RuntimeRequirementItem,
		changeKind: "create" | "update" | "delete",
		reason: string,
	): number => {
		const appended = appendRequirementVersion(versionData, {
			requirementId: snapshot.id,
			snapshot,
			changeKind,
			source: "agent",
			reason,
			now,
		});
		versionData = appended.data;
		summary.versionsWritten += 1;
		return appended.version.version;
	};

	const applyUpdate = (id: string, changes: RequirementReviewChanges, reason: string): { item: RuntimeRequirementItem; version: number } => {
		const result = updateRequirement(data, id, changes, now);
		if (!result.updated || !result.requirement) {
			throw new Error(`Requirement "${id}" was not found.`);
		}
		data = result.data;
		return { item: result.requirement, version: recordVersion(result.requirement, "update", reason) };
	};

	const applyDelete = (id: string, reason: string): number => {
		const result = deleteRequirement(data, id);
		if (!result.deleted || !result.requirement) {
			throw new Error(`Requirement "${id}" was not found.`);
		}
		data = result.data;
		return recordVersion(result.requirement, "delete", reason);
	};

	for (const action of plan.actions) {
		switch (action.kind) {
			case "update": {
				const { version } = applyUpdate(action.id, action.changes, action.reason);
				actions.push({ kind: "update", requirementId: action.id, what: describeChanges(action.changes), why: action.reason, version });
				summary.update += 1;
				break;
			}
			case "archive": {
				const { version } = applyUpdate(action.id, { status: "archived" }, action.reason);
				actions.push({ kind: "archive", requirementId: action.id, what: "set status to archived", why: action.reason, version });
				summary.archive += 1;
				break;
			}
			case "merge": {
				if (action.duplicateIds.includes(action.survivorId)) {
					throw new Error(`Requirement "${action.survivorId}" cannot be both the merge survivor and a duplicate.`);
				}
				let survivorVersion: number | null = null;
				if (action.changes && Object.values(action.changes).some((value) => value !== undefined)) {
					survivorVersion = applyUpdate(action.survivorId, action.changes, action.reason).version;
				} else if (!data.items.some((item) => item.id === action.survivorId)) {
					throw new Error(`Requirement "${action.survivorId}" was not found.`);
				}
				const deleted: RequirementVersionRef[] = action.duplicateIds.map((duplicateId) => ({
					requirementId: duplicateId,
					version: applyDelete(duplicateId, action.reason),
				}));
				actions.push({
					kind: "merge",
					survivorId: action.survivorId,
					what: `merged ${deleted.length} duplicate(s) into ${action.survivorId}`,
					why: action.reason,
					survivorVersion,
					deleted,
				});
				summary.merge += 1;
				break;
			}
			case "split": {
				let sourceVersion: number | null = null;
				if (action.sourceChanges && Object.values(action.sourceChanges).some((value) => value !== undefined)) {
					sourceVersion = applyUpdate(action.sourceId, action.sourceChanges, action.reason).version;
				} else if (!data.items.some((item) => item.id === action.sourceId)) {
					throw new Error(`Requirement "${action.sourceId}" was not found.`);
				}
				const created: RequirementVersionRef[] = action.newRequirements.map((input) => {
					const result = addRequirement(data, input, deps.randomUuid, now);
					data = result.data;
					return { requirementId: result.requirement.id, version: recordVersion(result.requirement, "create", action.reason) };
				});
				actions.push({
					kind: "split",
					sourceId: action.sourceId,
					what: `split into ${created.length} new requirement(s)`,
					why: action.reason,
					sourceVersion,
					created,
				});
				summary.split += 1;
				break;
			}
			case "delete": {
				const version = applyDelete(action.id, action.reason);
				actions.push({ kind: "delete", requirementId: action.id, what: "deleted requirement", why: action.reason, version });
				summary.delete += 1;
				break;
			}
		}
	}

	return { data, versions: versionData, report: { actions, summary } };
}
