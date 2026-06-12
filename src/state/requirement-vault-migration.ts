import { z } from "zod";

import { type RuntimeVaultFrontmatterValue, runtimeRequirementPrioritySchema } from "../core/api-contract";
import type { ImportVaultDocumentInput } from "../vault/vault-document-store";

/** The vault `type:` value requirements migrate into (`docs/requirement/<slug>-<id>.md`). */
export const REQUIREMENT_DOC_TYPE = "requirement";

// The pre-vault, delivery-flavored requirement status. Retired from the wire
// contract in B6 — it survives only as the on-disk shape this one-time migration
// reads, so it is defined locally here rather than shared to the frontend.
const legacyRequirementStatusSchema = z.enum(["draft", "active", "done", "archived"]);
type LegacyRequirementStatus = z.infer<typeof legacyRequirementStatusSchema>;

const legacyRequirementProblemStatusSchema = z.enum(["proposed", "clarified", "parked", "invalid"]);
type LegacyRequirementProblemStatus = z.infer<typeof legacyRequirementProblemStatusSchema>;

// A legacy requirement item as persisted by the retired requirement-store — one
// item per `requirements/<id>.json` shard, or an entry in the pre-shard
// `requirements.json` aggregate. Parsed permissively (unknown keys such as a
// former annotation are dropped); only the fields the vault import needs survive.
export const legacyRequirementItemSchema = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string().default(""),
	priority: runtimeRequirementPrioritySchema.default("medium"),
	status: legacyRequirementStatusSchema.default("draft"),
	linkedTaskIds: z.array(z.string()).default([]),
	order: z.number().default(0),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type LegacyRequirementItem = z.infer<typeof legacyRequirementItemSchema>;

export const legacyRequirementsDataSchema = z.object({
	items: z.array(legacyRequirementItemSchema).default([]),
});
export type LegacyRequirementsData = z.infer<typeof legacyRequirementsDataSchema>;

// A legacy one-way requirement → task link record. Only the ids matter to the
// migration; the former `source` annotation is parsed-and-dropped.
export const legacyRequirementTaskLinkSchema = z.object({
	requirementId: z.string(),
	taskId: z.string(),
	createdAt: z.number().default(0),
});
export type LegacyRequirementTaskLink = z.infer<typeof legacyRequirementTaskLinkSchema>;

export const legacyRequirementTaskLinksDataSchema = z.object({
	links: z.array(legacyRequirementTaskLinkSchema).default([]),
});
export type LegacyRequirementTaskLinksData = z.infer<typeof legacyRequirementTaskLinksDataSchema>;

// Forward map (migration only): delivery-flavored legacy status → customer-facing
// PROBLEM state. Intentionally lossy and documented — `active` and `done` both
// collapse to `clarified`, because a requirement describes a problem, not a
// delivery item. See the design doc's "Status reshape".
const STATUS_TO_PROBLEM_STATUS: Record<LegacyRequirementStatus, LegacyRequirementProblemStatus> = {
	draft: "proposed",
	active: "clarified",
	done: "clarified",
	archived: "parked",
};

export function requirementStatusToProblemStatus(status: LegacyRequirementStatus): LegacyRequirementProblemStatus {
	return STATUS_TO_PROBLEM_STATUS[status];
}

/**
 * The task ids a requirement references, combining the requirement's own
 * `linkedTaskIds` (the contract's source of truth for associations) with any
 * task-link records for it, de-duped and `linkedTaskIds`-first.
 */
export function collectRelatedTasks(
	item: LegacyRequirementItem,
	links: readonly LegacyRequirementTaskLink[],
): string[] {
	const seen = new Set<string>();
	const related: string[] = [];
	for (const taskId of item.linkedTaskIds) {
		if (!seen.has(taskId)) {
			seen.add(taskId);
			related.push(taskId);
		}
	}
	for (const link of links) {
		if (link.requirementId === item.id && !seen.has(link.taskId)) {
			seen.add(link.taskId);
			related.push(link.taskId);
		}
	}
	return related;
}

/**
 * Build the vault import payload for a legacy requirement: description → markdown
 * body, status → PROBLEM state, links → `related_tasks`, preserving the original
 * id and timestamps. The unused `source`/`order`/version history do not survive
 * (git is the new record).
 */
export function requirementItemToVaultImport(
	item: LegacyRequirementItem,
	relatedTasks: string[],
): ImportVaultDocumentInput {
	const frontmatter: Record<string, RuntimeVaultFrontmatterValue> = {
		status: requirementStatusToProblemStatus(item.status),
		priority: item.priority,
	};
	if (relatedTasks.length > 0) {
		frontmatter.related_tasks = relatedTasks;
	}
	return {
		id: item.id,
		type: REQUIREMENT_DOC_TYPE,
		title: item.title,
		body: item.description,
		frontmatter,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}
