import { z } from "zod";
import type {
	RuntimeBoardData,
	RuntimeRequirementItem,
	RuntimeRequirementsData,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementVersionsData,
} from "./api-contract";
import { runtimeRequirementPrioritySchema } from "./api-contract";
import { addRequirement } from "./requirement-mutations";
import { proposeLink } from "./requirement-task-link-mutations";
import { appendRequirementVersion } from "./requirement-versions";

// ---------------------------------------------------------------------------
// Analyze (phase 1): read-only reconcile packet for the agent to reason over.
// ---------------------------------------------------------------------------

export interface ReconcileOrphanTask {
	taskId: string;
	title: string;
	prompt: string;
	columnId: string;
	columnTitle: string;
}

export interface ReconcileRequirementSummary {
	id: string;
	title: string;
	description: string;
	status: RuntimeRequirementItem["status"];
	priority: RuntimeRequirementItem["priority"];
}

export interface ReconcilePendingLink {
	taskId: string;
	requirementId: string;
}

export interface ReconcilePacket {
	orphanTasks: ReconcileOrphanTask[];
	requirementCatalog: ReconcileRequirementSummary[];
	pendingProposed: ReconcilePendingLink[];
}

export function analyzeReconcile(
	board: RuntimeBoardData,
	requirements: RuntimeRequirementsData,
	links: RuntimeRequirementTaskLinksData,
): ReconcilePacket {
	const linkedTaskIds = new Set(links.links.map((entry) => entry.taskId));
	const orphanTasks: ReconcileOrphanTask[] = [];
	for (const col of board.columns) {
		for (const card of col.cards) {
			if (linkedTaskIds.has(card.id)) {
				continue;
			}
			orphanTasks.push({
				taskId: card.id,
				title: card.title,
				prompt: card.prompt,
				columnId: col.id,
				columnTitle: col.title,
			});
		}
	}
	const requirementCatalog = requirements.items.map(
		(item): ReconcileRequirementSummary => ({
			id: item.id,
			title: item.title,
			description: item.description,
			status: item.status,
			priority: item.priority,
		}),
	);
	const pendingProposed = links.links
		.filter((entry) => entry.status === "proposed")
		.map((entry): ReconcilePendingLink => ({ taskId: entry.taskId, requirementId: entry.requirementId }));
	return { orphanTasks, requirementCatalog, pendingProposed };
}

// ---------------------------------------------------------------------------
// Apply (phase 2): schema for the agent-decided reconcile plan.
// ---------------------------------------------------------------------------

const newDraftRequirementSchema = z
	.object({
		title: z.string().min(1),
		description: z.string().optional(),
		priority: runtimeRequirementPrioritySchema.optional(),
	})
	.strict();

const linkEntrySchema = z
	.object({
		action: z.literal("link"),
		taskId: z.string().min(1),
		requirementId: z.string().min(1),
		reason: z.string().min(1),
	})
	.strict();

const createDraftEntrySchema = z
	.object({
		action: z.literal("create-draft"),
		taskId: z.string().min(1),
		requirement: newDraftRequirementSchema,
		reason: z.string().min(1),
	})
	.strict();

export const reconcileEntrySchema = z.discriminatedUnion("action", [linkEntrySchema, createDraftEntrySchema]);
export type ReconcileEntry = z.infer<typeof reconcileEntrySchema>;

export const reconcilePlanSchema = z
	.object({
		entries: z.array(reconcileEntrySchema).min(1),
	})
	.strict();
export type ReconcilePlan = z.infer<typeof reconcilePlanSchema>;

// ---------------------------------------------------------------------------
// Apply (phase 2): execute the reconcile plan, threading state immutably.
// ---------------------------------------------------------------------------

function assertNeverReconcileEntry(entry: never): never {
	throw new Error(`Unhandled reconcile entry: ${JSON.stringify(entry)}`);
}

export interface ApplyReconcilePlanDeps {
	randomUuid: () => string;
	now?: number;
}

export interface ReconcileEntryReport {
	action: "link" | "create-draft";
	taskId: string;
	requirementId: string;
	why: string;
}

export interface ReconcileSummary {
	link: number;
	createDraft: number;
	versionsWritten: number;
}

export interface ReconcileReport {
	entries: ReconcileEntryReport[];
	summary: ReconcileSummary;
}

export interface ApplyReconcileResult {
	requirements: RuntimeRequirementsData;
	links: RuntimeRequirementTaskLinksData;
	versions: RuntimeRequirementVersionsData;
	report: ReconcileReport;
}

export function applyReconcilePlan(
	requirements: RuntimeRequirementsData,
	links: RuntimeRequirementTaskLinksData,
	versions: RuntimeRequirementVersionsData,
	plan: ReconcilePlan,
	deps: ApplyReconcilePlanDeps,
): ApplyReconcileResult {
	const now = deps.now ?? Date.now();
	let requirementsData = requirements;
	let linksData = links;
	let versionsData = versions;
	const entries: ReconcileEntryReport[] = [];
	const summary: ReconcileSummary = { link: 0, createDraft: 0, versionsWritten: 0 };

	for (const entry of plan.entries) {
		const versionsBefore = versionsData.versions.length;
		switch (entry.action) {
			case "link": {
				const result = proposeLink(requirementsData, linksData, versionsData, entry.requirementId, entry.taskId, {
					source: "agent",
					reason: entry.reason,
					now,
				});
				requirementsData = result.requirements;
				linksData = result.links;
				versionsData = result.versions;
				entries.push({
					action: "link",
					taskId: entry.taskId,
					requirementId: entry.requirementId,
					why: entry.reason,
				});
				summary.link += 1;
				break;
			}
			case "create-draft": {
				// status is forced to "draft" — the schema never lets the agent set it.
				const created = addRequirement(
					requirementsData,
					{
						title: entry.requirement.title,
						description: entry.requirement.description,
						priority: entry.requirement.priority,
						status: "draft",
					},
					deps.randomUuid,
					now,
				);
				requirementsData = created.data;
				versionsData = appendRequirementVersion(versionsData, {
					requirementId: created.requirement.id,
					snapshot: created.requirement,
					changeKind: "create",
					source: "agent",
					reason: entry.reason,
					now,
				}).data;
				const linked = proposeLink(
					requirementsData,
					linksData,
					versionsData,
					created.requirement.id,
					entry.taskId,
					{
						source: "agent",
						reason: entry.reason,
						now,
					},
				);
				requirementsData = linked.requirements;
				linksData = linked.links;
				versionsData = linked.versions;
				entries.push({
					action: "create-draft",
					taskId: entry.taskId,
					requirementId: created.requirement.id,
					why: entry.reason,
				});
				summary.createDraft += 1;
				break;
			}
			default:
				assertNeverReconcileEntry(entry);
		}
		summary.versionsWritten += versionsData.versions.length - versionsBefore;
	}

	return { requirements: requirementsData, links: linksData, versions: versionsData, report: { entries, summary } };
}
