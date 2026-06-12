import type {
	RuntimeVaultFilterCondition,
	RuntimeVaultFilterGroup,
	RuntimeVaultFilterNode,
	RuntimeVaultFrontmatterValue,
	RuntimeVaultSort,
} from "@/runtime/types";

import type { VaultDoc } from "./vault-doc-model";

/**
 * Pure evaluation of a vault saved view's filter expression and sort against the
 * in-memory `VaultDoc` list. Mirrors tolaria's `viewFilters` model: a recursive
 * `all`(AND)/`any`(OR) group of `{ field, op, value }` leaf conditions. Filtering
 * runs entirely client-side (docs are already loaded), so this module has no I/O.
 */

type ResolvedField = RuntimeVaultFrontmatterValue | undefined;

// Built-in (non-frontmatter) fields, matched case-insensitively. Everything else
// reads from the doc's frontmatter record.
function resolveField(doc: VaultDoc, field: string): ResolvedField {
	switch (field.toLowerCase()) {
		case "type":
			return doc.type;
		case "title":
		case "name":
			return doc.name;
		case "updated":
		case "updatedat":
			return doc.updatedAt;
		case "created":
		case "createdat":
			return doc.createdAt;
		case "body":
			return doc.body;
		default:
			return doc.frontmatter[field];
	}
}

function isEmptyValue(value: ResolvedField): boolean {
	if (value === undefined || value === null) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.length === 0;
	}
	return value === "";
}

function normalize(value: string | number | boolean): string {
	return String(value).toLowerCase();
}

// Coerce a condition `value` to the list of normalized strings used by the
// set operators (`any_of`/`none_of`). A scalar becomes a single-element list.
function conditionList(value: RuntimeVaultFrontmatterValue | undefined): string[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (Array.isArray(value)) {
		return value.map(normalize);
	}
	return [normalize(value)];
}

function conditionScalar(value: RuntimeVaultFrontmatterValue | undefined): string {
	if (value === undefined || value === null || Array.isArray(value)) {
		return "";
	}
	return normalize(value);
}

// Parse a field value or condition value to an epoch-ms timestamp. Numbers are
// already ms (matches `createdAt`/`updatedAt`); strings go through `Date.parse`
// (handles ISO `YYYY-MM-DD` and full datetimes).
function toTimestamp(value: RuntimeVaultFrontmatterValue | undefined): number | null {
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

function evaluateDate(cond: RuntimeVaultFilterCondition, resolved: ResolvedField): boolean {
	const fieldTs = toTimestamp(resolved);
	const targetTs = toTimestamp(cond.value);
	if (fieldTs === null || targetTs === null) {
		return false;
	}
	return cond.op === "before" ? fieldTs < targetTs : fieldTs > targetTs;
}

function evaluateArray(cond: RuntimeVaultFilterCondition, values: string[]): boolean {
	const set = new Set(values);
	switch (cond.op) {
		case "contains":
			return set.has(conditionScalar(cond.value));
		case "not_contains":
			return !set.has(conditionScalar(cond.value));
		case "equals":
			return values.length === 1 && set.has(conditionScalar(cond.value));
		case "not_equals":
			return !(values.length === 1 && set.has(conditionScalar(cond.value)));
		case "any_of":
			return conditionList(cond.value).some((v) => set.has(v));
		case "none_of":
			return !conditionList(cond.value).some((v) => set.has(v));
		default:
			return false;
	}
}

function evaluateScalar(cond: RuntimeVaultFilterCondition, resolved: ResolvedField): boolean {
	const field = resolved === undefined || resolved === null ? "" : normalize(resolved as string | number | boolean);
	const value = conditionScalar(cond.value);
	switch (cond.op) {
		case "equals":
			return field === value;
		case "not_equals":
			return field !== value;
		case "contains":
			return field.includes(value);
		case "not_contains":
			return !field.includes(value);
		case "any_of":
			return conditionList(cond.value).includes(field);
		case "none_of":
			return !conditionList(cond.value).includes(field);
		default:
			return false;
	}
}

function evaluateCondition(doc: VaultDoc, cond: RuntimeVaultFilterCondition): boolean {
	const resolved = resolveField(doc, cond.field);

	if (cond.op === "is_empty") {
		return isEmptyValue(resolved);
	}
	if (cond.op === "is_not_empty") {
		return !isEmptyValue(resolved);
	}
	if (cond.op === "before" || cond.op === "after") {
		return evaluateDate(cond, resolved);
	}
	if (Array.isArray(resolved)) {
		return evaluateArray(cond, resolved.map(normalize));
	}
	return evaluateScalar(cond, resolved);
}

function isGroup(node: RuntimeVaultFilterNode): node is RuntimeVaultFilterGroup {
	return "all" in node || "any" in node;
}

function evaluateNode(doc: VaultDoc, node: RuntimeVaultFilterNode): boolean {
	return isGroup(node) ? matchesFilterGroup(doc, node) : evaluateCondition(doc, node);
}

/** Recursively evaluate a filter group against a document. An empty group matches. */
export function matchesFilterGroup(doc: VaultDoc, group: RuntimeVaultFilterGroup): boolean {
	if ("all" in group) {
		return group.all.every((node) => evaluateNode(doc, node));
	}
	return group.any.some((node) => evaluateNode(doc, node));
}

function sortKey(doc: VaultDoc, field: string): string | number {
	const resolved = resolveField(doc, field);
	if (typeof resolved === "number") {
		return resolved;
	}
	if (resolved === undefined || resolved === null) {
		return "";
	}
	if (Array.isArray(resolved)) {
		return resolved.map((v) => String(v)).join(", ");
	}
	return String(resolved);
}

/** Return a new array sorted by the view's sort field/direction (input is not mutated). */
export function sortVaultDocs(docs: VaultDoc[], sort: RuntimeVaultSort): VaultDoc[] {
	const flip = sort.direction === "asc" ? 1 : -1;
	return [...docs].sort((a, b) => {
		const ka = sortKey(a, sort.field);
		const kb = sortKey(b, sort.field);
		if (typeof ka === "number" && typeof kb === "number") {
			return flip * (ka - kb);
		}
		return flip * String(ka).localeCompare(String(kb));
	});
}

export interface ApplyVaultViewOptions {
	filters?: RuntimeVaultFilterGroup;
	sort?: RuntimeVaultSort | null;
}

/** Filter then sort a doc list according to a saved view. */
export function applyVaultView(docs: VaultDoc[], options: ApplyVaultViewOptions): VaultDoc[] {
	const { filters, sort } = options;
	const filtered = filters ? docs.filter((doc) => matchesFilterGroup(doc, filters)) : docs;
	return sort ? sortVaultDocs(filtered, sort) : filtered;
}
