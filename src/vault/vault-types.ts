import matter from "gray-matter";

import { coerceFrontmatterValue, type VaultFrontmatterValue } from "./vault-document";

/**
 * A vault type maps a `type:` value to the display + default metadata a view and
 * the document store need, plus a self-contained authoring prompt (`body`). Types
 * are **data-driven**: each one is a markdown document under `docs/_types/<type>.md`
 * (frontmatter = this metadata, body = the prompt), discovered at runtime — the
 * engine itself stays type-agnostic and serves unregistered types permissively.
 */
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

function normalizeBody(text: string): string {
	return text.replace(/^\n+/, "").replace(/\n+$/, "");
}
