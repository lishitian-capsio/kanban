import matter from "gray-matter";

import { coerceFrontmatterValue, type VaultFrontmatterValue } from "./vault-document";

/**
 * A vault type maps a `type:` value to the display + default metadata a view and
 * the document store need, plus a self-contained authoring prompt (`body`). Types
 * are **data-driven**: each one is a markdown document under `docs/_types/<type>.md`
 * (frontmatter = this metadata, body = the prompt), discovered at runtime — the
 * engine itself stays type-agnostic and serves unregistered types permissively.
 */
/**
 * A **typed relation** a document of one type may declare toward others — the schema
 * layer T2/T3/T5 build on. It describes an edge (e.g. a task `blocks` other tasks),
 * not the edge data itself; the link engine is untouched. The relation name is the
 * key it is stored under in {@link VaultTypeDefinition.relations}.
 */
export interface VaultRelationDefinition {
	/** Relation name, mirrored from its key in {@link VaultTypeDefinition.relations}. */
	name?: string;
	/** Human display label for the forward direction. */
	label?: string;
	/** Allowed target type id(s); omitted or `"*"` means any type. */
	target?: string | string[];
	/** Whether a document may hold one or many of this relation. Defaults to `"many"`. */
	cardinality?: "one" | "many";
	/** Relation name on the target type that points back (the reverse edge). */
	inverse?: string;
	/** Human display label for the inverse direction. */
	inverseLabel?: string;
}

export interface VaultTypeDefinition {
	/** Type id, from the `name` frontmatter field (e.g. "requirement"). */
	type: string;
	/** Human display label. */
	label: string;
	/** One-line "when to use me", shown in type pickers / progressive-disclosure indexes. */
	description?: string;
	/** Optional icon hint (a lucide icon name). */
	icon?: string;
	/** Frontmatter key whose value seeds the filename slug (usually "title"). */
	slugField: string;
	/** Ordered status values, used to build board columns for this type. */
	statusEnum?: readonly string[];
	/** Frontmatter applied to a freshly created doc before the caller's overrides. */
	defaultFrontmatter?: Record<string, VaultFrontmatterValue>;
	/** Typed relations this type may declare toward others, keyed by relation name. */
	relations?: Record<string, VaultRelationDefinition>;
	/** The self-governing authoring prompt — how to write a doc of this type (markdown, verbatim). */
	body: string;
}

export class VaultTypeDefinitionParseError extends Error {}

const DEFAULT_SLUG_FIELD = "title";

/**
 * Parse a `_types/<type>.md` document into a {@link VaultTypeDefinition}. Uses
 * `gray-matter` directly rather than {@link parseVaultDocument} because a type's
 * `default_frontmatter` is a *nested* map, which the document parser deliberately
 * flattens to a string. Skill-aligned frontmatter (`name`/`description` + body).
 */
export function parseVaultTypeDefinition(raw: string): VaultTypeDefinition {
	const parsed = matter(raw);
	const data = parsed.data as Record<string, unknown>;

	const type = data.name;
	if (typeof type !== "string" || type.length === 0) {
		throw new VaultTypeDefinitionParseError("type definition is missing a string `name` frontmatter field");
	}
	const label = data.label;
	if (typeof label !== "string" || label.length === 0) {
		throw new VaultTypeDefinitionParseError("type definition is missing a string `label` frontmatter field");
	}

	const definition: VaultTypeDefinition = {
		type,
		label,
		slugField:
			typeof data.slug_field === "string" && data.slug_field.length > 0 ? data.slug_field : DEFAULT_SLUG_FIELD,
		body: normalizeBody(parsed.content),
	};
	if (typeof data.description === "string") {
		definition.description = data.description;
	}
	if (typeof data.icon === "string") {
		definition.icon = data.icon;
	}
	const statusEnum = parseStatusEnum(data.status_enum);
	if (statusEnum) {
		definition.statusEnum = statusEnum;
	}
	const defaultFrontmatter = parseDefaultFrontmatter(data.default_frontmatter);
	if (defaultFrontmatter) {
		definition.defaultFrontmatter = defaultFrontmatter;
	}
	const relations = parseRelations(data.relations);
	if (relations) {
		definition.relations = relations;
	}
	return definition;
}

/**
 * Serialize a {@link VaultTypeDefinition} back to a `_types/<type>.md` document,
 * emitting frontmatter keys in a fixed canonical order so writes are deterministic
 * and produce meaningful git diffs.
 */
export function serializeVaultTypeDefinition(definition: VaultTypeDefinition): string {
	const frontmatter: Record<string, unknown> = { name: definition.type, label: definition.label };
	if (definition.description !== undefined) {
		frontmatter.description = definition.description;
	}
	if (definition.icon !== undefined) {
		frontmatter.icon = definition.icon;
	}
	frontmatter.slug_field = definition.slugField;
	if (definition.statusEnum) {
		frontmatter.status_enum = [...definition.statusEnum];
	}
	if (definition.defaultFrontmatter) {
		frontmatter.default_frontmatter = definition.defaultFrontmatter;
	}
	// Emit `relations` as a known canonical key so a write through the registry never
	// silently drops hand-authored typed relations on the way back to disk.
	if (definition.relations) {
		frontmatter.relations = serializeRelations(definition.relations);
	}
	return matter.stringify(normalizeBody(definition.body), frontmatter);
}

function parseStatusEnum(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const statuses = value.filter((entry): entry is string => typeof entry === "string");
	return statuses.length > 0 ? statuses : undefined;
}

function parseDefaultFrontmatter(value: unknown): Record<string, VaultFrontmatterValue> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const result: Record<string, VaultFrontmatterValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = coerceFrontmatterValue(entry);
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Read a nested `relations:` frontmatter map into typed {@link VaultRelationDefinition}s.
 * A non-map value, or an individual entry that is not a map (a half-written / torn block),
 * is tolerated by skipping it — mirroring the scan's "one bad file never empties" stance.
 */
function parseRelations(value: unknown): Record<string, VaultRelationDefinition> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const result: Record<string, VaultRelationDefinition> = {};
	for (const [name, entry] of Object.entries(value)) {
		const relation = parseRelation(name, entry);
		if (relation) {
			result[name] = relation;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function parseRelation(name: string, value: unknown): VaultRelationDefinition | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const entry = value as Record<string, unknown>;
	const relation: VaultRelationDefinition = { name };
	if (typeof entry.label === "string") {
		relation.label = entry.label;
	}
	const target = parseRelationTarget(entry.target);
	if (target !== undefined) {
		relation.target = target;
	}
	if (entry.cardinality === "one" || entry.cardinality === "many") {
		relation.cardinality = entry.cardinality;
	}
	if (typeof entry.inverse === "string") {
		relation.inverse = entry.inverse;
	}
	if (typeof entry.inverse_label === "string") {
		relation.inverseLabel = entry.inverse_label;
	}
	return relation;
}

function parseRelationTarget(value: unknown): string | string[] | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		const targets = value.filter((entry): entry is string => typeof entry === "string");
		return targets.length > 0 ? targets : undefined;
	}
	return undefined;
}

/**
 * Serialize typed relations back to a nested `relations:` map, each relation's keys in a
 * fixed canonical order. The relation name lives in the map key, so it is not re-emitted
 * inside the entry (and `inverseLabel` is written under its on-disk `inverse_label` key).
 */
function serializeRelations(relations: Record<string, VaultRelationDefinition>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [name, relation] of Object.entries(relations)) {
		const entry: Record<string, unknown> = {};
		if (relation.label !== undefined) {
			entry.label = relation.label;
		}
		if (relation.target !== undefined) {
			entry.target = Array.isArray(relation.target) ? [...relation.target] : relation.target;
		}
		if (relation.cardinality !== undefined) {
			entry.cardinality = relation.cardinality;
		}
		if (relation.inverse !== undefined) {
			entry.inverse = relation.inverse;
		}
		if (relation.inverseLabel !== undefined) {
			entry.inverse_label = relation.inverseLabel;
		}
		result[name] = entry;
	}
	return result;
}

function normalizeBody(text: string): string {
	return text.replace(/^\n+/, "").replace(/\n+$/, "");
}

/** A relation name / inverse name: a letter, then letters, digits, `_` or `-`. */
const RELATION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Reduce a relation's `target` to its concrete named types, dropping the `"*"` / omitted "any" cases. */
function concreteRelationTargets(target: string | string[] | undefined): string[] {
	if (target === undefined) {
		return [];
	}
	const list = Array.isArray(target) ? target : [target];
	return list.filter((entry) => entry !== "*");
}

/**
 * Strictly validate the typed-relation schema of a type that is about to be **written**
 * through the registry. This is deliberately stricter than the read path
 * ({@link parseRelations}, which tolerates torn/half-written entries by skipping them):
 * authoring a type is authoritative, so a malformed relation is rejected rather than
 * silently dropped (CLI rule — "写类型要严", cf. the advisory validation used when writing
 * a *document*).
 *
 * `otherTypes` is every OTHER type currently on disk; the type being written is folded in
 * so self-referential relations resolve. Checks, per relation (keyed by name):
 *  - the relation name is a valid identifier;
 *  - `cardinality`, when set, is `"one"` | `"many"`;
 *  - every concrete `target` type exists (in `otherTypes` ∪ the type being written);
 *    an omitted target or `"*"` means "any" and is not checked;
 *  - a declared `inverse` is a valid identifier, resolves against a concrete target type,
 *    and that target type declares a relation of that name whose own target points back to
 *    this type (or is "any") — i.e. the reverse edge exists and is type-compatible.
 *
 * Returns the list of human-readable violations; an empty array means the schema is valid.
 */
export function validateVaultTypeRelations(
	definition: VaultTypeDefinition,
	otherTypes: readonly VaultTypeDefinition[],
): string[] {
	const errors: string[] = [];
	if (!definition.relations) {
		return errors;
	}

	// Known types = every other type on disk, plus the one being written, so a self-relation
	// (or a mutually-inverse pair created in one shot) resolves against the new definition.
	const known = new Map<string, VaultTypeDefinition>();
	for (const other of otherTypes) {
		if (other.type !== definition.type) {
			known.set(other.type, other);
		}
	}
	known.set(definition.type, definition);

	for (const [name, relation] of Object.entries(definition.relations)) {
		if (!RELATION_NAME_PATTERN.test(name)) {
			errors.push(`relation "${name}" has an invalid name (expected a letter, then letters, digits, "_" or "-")`);
		}
		if (relation.cardinality !== undefined && relation.cardinality !== "one" && relation.cardinality !== "many") {
			errors.push(
				`relation "${name}" has an invalid cardinality "${relation.cardinality}" (expected "one" or "many")`,
			);
		}

		const targets = concreteRelationTargets(relation.target);
		for (const target of targets) {
			if (!known.has(target)) {
				errors.push(`relation "${name}" targets unknown type "${target}"`);
			}
		}

		if (relation.inverse !== undefined) {
			validateInverse(definition.type, name, relation.inverse, targets, known, errors);
		}
	}
	return errors;
}

function validateInverse(
	fromType: string,
	name: string,
	inverse: string,
	targets: string[],
	known: Map<string, VaultTypeDefinition>,
	errors: string[],
): void {
	if (!RELATION_NAME_PATTERN.test(inverse)) {
		errors.push(`relation "${name}" has an invalid inverse name "${inverse}"`);
		return;
	}
	if (targets.length === 0) {
		errors.push(`relation "${name}" declares inverse "${inverse}" but has no concrete target type to bind it to`);
		return;
	}
	for (const target of targets) {
		const targetType = known.get(target);
		if (!targetType) {
			continue; // Already reported as an unknown target above.
		}
		const reverse = targetType.relations?.[inverse];
		if (!reverse) {
			errors.push(
				`relation "${name}" declares inverse "${inverse}", but type "${target}" has no relation named "${inverse}"`,
			);
			continue;
		}
		const reverseTargets = concreteRelationTargets(reverse.target);
		const pointsBack = reverseTargets.length === 0 || reverseTargets.includes(fromType);
		if (!pointsBack) {
			errors.push(
				`relation "${name}" declares inverse "${inverse}" on type "${target}", but that relation does not target "${fromType}"`,
			);
		}
	}
}
