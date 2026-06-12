import { Building2, GitBranch, ListChecks, type LucideIcon, StickyNote } from "lucide-react";

/**
 * Client-side mirror of the backend `vaultTypeRegistry` (`src/vault/vault-types.ts`).
 * The backend registry isn't exposed over tRPC, so the view layer carries its own
 * display metadata: status/priority enums, table columns, the create template, and
 * default frontmatter. Adding a type here + a backend entry is the "nearly-free new
 * type" seam. MVP registers only `requirement`.
 */

export type VaultPropertyKind = "title" | "status" | "priority" | "customer" | "text" | "updated";

export interface VaultStatusOption {
	value: string;
	label: string;
	/** Tailwind border+text classes for the status badge. */
	badgeClass: string;
}

export interface VaultPriorityOption {
	value: string;
	label: string;
	/** Tailwind text-color class for the priority dot. */
	dotClass: string;
}

export interface VaultColumnSpec {
	/** Frontmatter key the column reads (ignored for the `title`/`updated` kinds). */
	key: string;
	label: string;
	kind: VaultPropertyKind;
}

export interface VaultTypeView {
	type: string;
	label: string;
	pluralLabel: string;
	icon: LucideIcon;
	/** Frontmatter key holding the board/grouping status. */
	statusKey: string;
	statuses: VaultStatusOption[];
	priorities: VaultPriorityOption[];
	/** Table columns, in display order. */
	columns: VaultColumnSpec[];
	/**
	 * Full markdown template (YAML frontmatter + body) seeded into a new doc of
	 * this type. The create flow parses it with `parseFrontmatter`, so a new type
	 * needs only this string — frontmatter defaults and starter body live together.
	 */
	template: string;
}

// PROBLEM-state lifecycle (在提 / 已澄清 / 搁置 / 失效): a requirement faces the
// customer, so its states describe the problem, not delivery.
const REQUIREMENT_STATUSES: VaultStatusOption[] = [
	{ value: "proposed", label: "Proposed", badgeClass: "border-status-blue/40 text-status-blue" },
	{ value: "clarified", label: "Clarified", badgeClass: "border-status-green/40 text-status-green" },
	{ value: "parked", label: "Parked", badgeClass: "border-status-orange/40 text-status-orange" },
	{ value: "invalid", label: "Invalid", badgeClass: "border-border text-text-tertiary" },
];

const REQUIREMENT_PRIORITIES: VaultPriorityOption[] = [
	{ value: "low", label: "Low", dotClass: "text-text-tertiary" },
	{ value: "medium", label: "Medium", dotClass: "text-status-blue" },
	{ value: "high", label: "High", dotClass: "text-status-orange" },
	{ value: "urgent", label: "Urgent", dotClass: "text-status-red" },
];

const REQUIREMENT_TEMPLATE = `---
status: proposed
priority: medium
customer: ""
---

## Context

Who is the customer and what is the situation?

## Problem

What problem are they facing?

## Desired outcome

What does success look like for them?

## Acceptance criteria

- [ ]
`;

const requirementView: VaultTypeView = {
	type: "requirement",
	label: "Requirement",
	pluralLabel: "Requirements",
	icon: ListChecks,
	statusKey: "status",
	statuses: REQUIREMENT_STATUSES,
	priorities: REQUIREMENT_PRIORITIES,
	columns: [
		{ key: "title", label: "Title", kind: "title" },
		{ key: "status", label: "Status", kind: "status" },
		{ key: "priority", label: "Priority", kind: "priority" },
		{ key: "customer", label: "Customer", kind: "customer" },
		{ key: "updatedAt", label: "Updated", kind: "updated" },
	],
	template: REQUIREMENT_TEMPLATE,
};

// Customer: the physical anchor (客户). No status lifecycle and no board — a flat
// table of accounts. Requirements point at it via their `customer` wikilink, and
// supporting files hang off it via the `materials` array (see CustomerAnchorPanel).
const CUSTOMER_TEMPLATE = `---
contact: ""
materials: []
---

## About

Who is this customer and what do they do?

## Context

Key background, relationships, and history.
`;

const customerView: VaultTypeView = {
	type: "customer",
	label: "Customer",
	pluralLabel: "Customers",
	icon: Building2,
	statusKey: "status",
	statuses: [],
	priorities: [],
	columns: [
		{ key: "title", label: "Title", kind: "title" },
		{ key: "contact", label: "Contact", kind: "text" },
		{ key: "updatedAt", label: "Updated", kind: "updated" },
	],
	template: CUSTOMER_TEMPLATE,
};

// Decision (ADR): crystallized from a conversation, then ratified over time.
const DECISION_STATUSES: VaultStatusOption[] = [
	{ value: "proposed", label: "Proposed", badgeClass: "border-status-blue/40 text-status-blue" },
	{ value: "accepted", label: "Accepted", badgeClass: "border-status-green/40 text-status-green" },
	{ value: "superseded", label: "Superseded", badgeClass: "border-status-orange/40 text-status-orange" },
	{ value: "rejected", label: "Rejected", badgeClass: "border-border text-text-tertiary" },
];

const DECISION_TEMPLATE = `---
status: proposed
---

## Context

What is the situation that forces a decision?

## Decision

What did we decide?

## Consequences

What becomes easier or harder as a result?
`;

const decisionView: VaultTypeView = {
	type: "decision",
	label: "Decision",
	pluralLabel: "Decisions",
	icon: GitBranch,
	statusKey: "status",
	statuses: DECISION_STATUSES,
	priorities: [],
	columns: [
		{ key: "title", label: "Title", kind: "title" },
		{ key: "status", label: "Status", kind: "status" },
		{ key: "updatedAt", label: "Updated", kind: "updated" },
	],
	template: DECISION_TEMPLATE,
};

// Note / meeting minutes (纪要): a free-form crystallized record, no lifecycle.
const NOTE_TEMPLATE = `---
---

## Summary

## Notes
`;

const noteView: VaultTypeView = {
	type: "note",
	label: "Note",
	pluralLabel: "Notes",
	icon: StickyNote,
	statusKey: "status",
	statuses: [],
	priorities: [],
	columns: [
		{ key: "title", label: "Title", kind: "title" },
		{ key: "updatedAt", label: "Updated", kind: "updated" },
	],
	template: NOTE_TEMPLATE,
};

const VAULT_TYPE_VIEWS: Record<string, VaultTypeView> = {
	requirement: requirementView,
	customer: customerView,
	decision: decisionView,
	note: noteView,
};

export function getVaultTypeView(type: string): VaultTypeView | undefined {
	return VAULT_TYPE_VIEWS[type];
}

export function listVaultTypeViews(): VaultTypeView[] {
	return Object.values(VAULT_TYPE_VIEWS);
}

export function getStatusOption(view: VaultTypeView, value: string | null | undefined): VaultStatusOption | undefined {
	return view.statuses.find((status) => status.value === value);
}

export function getPriorityOption(
	view: VaultTypeView,
	value: string | null | undefined,
): VaultPriorityOption | undefined {
	return view.priorities.find((priority) => priority.value === value);
}
