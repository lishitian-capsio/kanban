import { z } from "zod";

import { runtimeRequirementPrioritySchema } from "../core/api-contract";
import type { VaultFrontmatterValue } from "./vault-document";

/**
 * A vault type maps a `type:` value to optional frontmatter validation plus the
 * display + default metadata a view needs. Adding a new type (Customer, ADR,
 * Spec, Note, …) is a new entry here + a type-definition doc + a view — the
 * engine itself stays type-agnostic and serves unregistered types permissively.
 */
export interface VaultTypeDefinition {
	type: string;
	label: string;
	/** Frontmatter key whose value seeds the filename slug (usually "title"). */
	slugField: string;
	/** Ordered status values, used to build board columns for this type. */
	statusEnum?: readonly string[];
	/** Frontmatter applied to a freshly created doc before the caller's overrides. */
	defaultFrontmatter?: Record<string, VaultFrontmatterValue>;
	/** Opt-in validation for this type's frontmatter; unset = accept anything. */
	frontmatterSchema?: z.ZodTypeAny;
}

// Problem-state lifecycle (在提 / 已澄清 / 搁置 / 失效) — a requirement faces the
// customer, so its states describe the *problem*, not delivery. B2 lifts this
// enum into the api-contract wire schema; it lives here until then.
const requirementProblemStatusSchema = z.enum(["proposed", "clarified", "parked", "invalid"]);

export const REQUIREMENT_PROBLEM_STATUSES = requirementProblemStatusSchema.options;

const requirementFrontmatterSchema = z
	.object({
		title: z.string().min(1),
		status: requirementProblemStatusSchema,
		priority: runtimeRequirementPrioritySchema,
		customer: z.string().nullable().optional(),
		related_tasks: z.array(z.string()).optional(),
	})
	.passthrough();

// Decision (ADR-flavored) lifecycle. Decisions are crystallized out of a chat and
// then ratified, so the states describe the decision's standing over time.
export const DECISION_STATUSES = ["proposed", "accepted", "superseded", "rejected"] as const;

export const vaultTypeRegistry: Record<string, VaultTypeDefinition> = {
	requirement: {
		type: "requirement",
		label: "Requirement",
		slugField: "title",
		statusEnum: REQUIREMENT_PROBLEM_STATUSES,
		defaultFrontmatter: { status: "proposed", priority: "medium" },
		frontmatterSchema: requirementFrontmatterSchema,
	},
	// Customer is the physical anchor of a requirement (客户 → 需求 → 任务). It has no
	// status lifecycle; requirements reference it via a `customer` wikilink and pin
	// supporting material via a `materials` array of file-library ids.
	customer: {
		type: "customer",
		label: "Customer",
		slugField: "title",
	},
	decision: {
		type: "decision",
		label: "Decision",
		slugField: "title",
		statusEnum: DECISION_STATUSES,
		defaultFrontmatter: { status: "proposed" },
	},
	// Note / meeting minutes (纪要): a free-form crystallized record, no lifecycle.
	note: {
		type: "note",
		label: "Note",
		slugField: "title",
	},
};

export function getVaultTypeDefinition(type: string): VaultTypeDefinition | undefined {
	return vaultTypeRegistry[type];
}

export function listVaultTypeDefinitions(): VaultTypeDefinition[] {
	return Object.values(vaultTypeRegistry);
}
