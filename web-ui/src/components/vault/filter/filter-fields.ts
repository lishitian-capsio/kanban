import type { RuntimeVaultFilterOp } from "@/runtime/types";

import type { VaultColumnSpec, VaultStatusOption, VaultTypeView } from "../data/vault-type-registry";

/**
 * Field/operator metadata derived from a {@link VaultTypeView}, driving the filter
 * builder UI: which fields a user can filter on, which operators apply to each, and
 * (for enum-backed fields) the value options. The field `key` is exactly what the
 * pure evaluator (`vault-filter.ts`) resolves — a built-in (`type`/`title`/
 * `updatedAt`) or a frontmatter key.
 */

export type FilterFieldKind = "text" | "status" | "priority" | "date" | "type";

export interface FilterFieldOption {
	value: string;
	label: string;
}

export interface FilterField {
	key: string;
	label: string;
	kind: FilterFieldKind;
	/** Enum value choices for status/priority/type fields. */
	options?: FilterFieldOption[];
}

const ALL_OPS: RuntimeVaultFilterOp[] = [
	"equals",
	"not_equals",
	"contains",
	"not_contains",
	"any_of",
	"none_of",
	"is_empty",
	"is_not_empty",
];
const ENUM_OPS: RuntimeVaultFilterOp[] = ["equals", "not_equals", "any_of", "none_of", "is_empty", "is_not_empty"];
const DATE_OPS: RuntimeVaultFilterOp[] = ["before", "after", "equals", "is_empty", "is_not_empty"];

export const OP_LABELS: Record<RuntimeVaultFilterOp, string> = {
	equals: "is",
	not_equals: "is not",
	contains: "contains",
	not_contains: "does not contain",
	any_of: "is any of",
	none_of: "is none of",
	is_empty: "is empty",
	is_not_empty: "is not empty",
	before: "before",
	after: "after",
};

/** Operators valid for a field kind. */
export function operatorsForKind(kind: FilterFieldKind): RuntimeVaultFilterOp[] {
	switch (kind) {
		case "date":
			return DATE_OPS;
		case "status":
		case "priority":
		case "type":
			return ENUM_OPS;
		default:
			return ALL_OPS;
	}
}

/** Operators that take no value input. */
export function isUnaryOp(op: RuntimeVaultFilterOp): boolean {
	return op === "is_empty" || op === "is_not_empty";
}

/** Operators whose value is a list (comma-separated in the UI). */
export function isSetOp(op: RuntimeVaultFilterOp): boolean {
	return op === "any_of" || op === "none_of";
}

function fieldKindForColumn(column: VaultColumnSpec): FilterFieldKind {
	switch (column.kind) {
		case "status":
			return "status";
		case "priority":
			return "priority";
		case "updated":
			return "date";
		default:
			return "text";
	}
}

function toOptions(statuses: VaultStatusOption[]): FilterFieldOption[] {
	return statuses.map((status) => ({ value: status.value, label: status.label }));
}

/** The fields a user can filter or sort on for a given document type. */
export function availableFilterFields(view: VaultTypeView): FilterField[] {
	const fields: FilterField[] = [
		{ key: "type", label: "Type", kind: "type", options: [{ value: view.type, label: view.label }] },
	];
	for (const column of view.columns) {
		const kind = column.kind === "title" ? "text" : fieldKindForColumn(column);
		const field: FilterField = { key: column.key, label: column.label, kind };
		if (column.kind === "status") {
			field.options = toOptions(view.statuses);
		} else if (column.kind === "priority") {
			field.options = view.priorities.map((p) => ({ value: p.value, label: p.label }));
		}
		fields.push(field);
	}
	return fields;
}

export function findFilterField(view: VaultTypeView, key: string): FilterField | undefined {
	return availableFilterFields(view).find((field) => field.key === key);
}
