import {
	type RuntimeRequirementItem,
	type RuntimeRequirementPriority,
	type RuntimeRequirementProblemStatus,
	type RuntimeRequirementStatus,
	type RuntimeRequirementTaskLink,
	type RuntimeVaultDocument,
	type RuntimeVaultFrontmatterValue,
	runtimeRequirementPrioritySchema,
} from "../core/api-contract";
import type { ImportVaultDocumentInput } from "../vault/vault-document-store";

/** The vault `type:` value requirements migrate into (`docs/requirement/<slug>-<id>.md`). */
export const REQUIREMENT_DOC_TYPE = "requirement";

// Forward map (migration): delivery-flavored legacy status → customer-facing
// PROBLEM state. Intentionally lossy and documented — `active` and `done` both
// collapse to `clarified`, because a requirement describes a problem, not a
// delivery item. See the design doc's "Status reshape".
const STATUS_TO_PROBLEM_STATUS: Record<RuntimeRequirementStatus, RuntimeRequirementProblemStatus> = {
	draft: "proposed",
	active: "clarified",
	done: "clarified",
	archived: "parked",
};

// Reverse map (transition-window read backfill only): project a PROBLEM state
// back onto the legacy status enum so the pre-vault read contract stays valid
// until the requirement types are retired (B6). Lossy by construction — the
// forward map collapsed active/done, so `clarified` resolves to `active`, the
// legacy "in flight" state.
const PROBLEM_STATUS_TO_STATUS: Record<RuntimeRequirementProblemStatus, RuntimeRequirementStatus> = {
	proposed: "draft",
	clarified: "active",
	parked: "archived",
	invalid: "archived",
};

export function requirementStatusToProblemStatus(status: RuntimeRequirementStatus): RuntimeRequirementProblemStatus {
	return STATUS_TO_PROBLEM_STATUS[status];
}

export function problemStatusToRequirementStatus(status: string): RuntimeRequirementStatus {
	return PROBLEM_STATUS_TO_STATUS[status as RuntimeRequirementProblemStatus] ?? "draft";
}

/**
 * The task ids a requirement references, combining the requirement's own
 * `linkedTaskIds` (the contract's source of truth for associations) with any
 * task-link records for it, de-duped and `linkedTaskIds`-first.
 */
export function collectRelatedTasks(
	item: RuntimeRequirementItem,
	links: readonly RuntimeRequirementTaskLink[],
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
	item: RuntimeRequirementItem,
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

/**
 * Project a vault requirement document back onto the legacy `RuntimeRequirementItem`
 * contract so the pre-vault read path keeps serving data after migration. `order`
 * is supplied by the caller (docs carry no order field).
 */
export function vaultDocumentToRequirementItem(doc: RuntimeVaultDocument, order: number): RuntimeRequirementItem {
	return {
		id: doc.id,
		title: doc.title,
		description: doc.body,
		priority: readPriority(doc.frontmatter.priority),
		status: problemStatusToRequirementStatus(asString(doc.frontmatter.status)),
		linkedTaskIds: readStringArray(doc.frontmatter.related_tasks),
		order,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
	};
}

function readPriority(value: RuntimeVaultFrontmatterValue | undefined): RuntimeRequirementPriority {
	const parsed = runtimeRequirementPrioritySchema.safeParse(value);
	return parsed.success ? parsed.data : "medium";
}

function readStringArray(value: RuntimeVaultFrontmatterValue | undefined): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string");
	}
	return typeof value === "string" && value.length > 0 ? [value] : [];
}

function asString(value: RuntimeVaultFrontmatterValue | undefined): string {
	return typeof value === "string" ? value : "";
}
