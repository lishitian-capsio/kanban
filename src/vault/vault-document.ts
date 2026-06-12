import matter from "gray-matter";

/**
 * A frontmatter value we round-trip faithfully: a scalar, null, or an array of
 * scalars. Nested maps are outside the document model — {@link parseVaultDocument}
 * coerces anything richer to a string so a hand-edited file never crashes a scan.
 */
export type VaultFrontmatterValue = string | number | boolean | null | Array<string | number | boolean>;

/**
 * The disk-facing shape of a vault document: markdown body + YAML frontmatter,
 * with the two identity fields (`_id`, `type`) promoted out of `frontmatter`.
 * Filesystem location is not intrinsic to the content, so it is attached by the
 * store layer rather than carried here.
 */
export interface VaultDocument {
	/** Stable id, from the `_id` frontmatter field. */
	id: string;
	/** Collection / schema selector, from the `type` frontmatter field. */
	type: string;
	/** Every other frontmatter key (excludes `_id` and `type`). */
	frontmatter: Record<string, VaultFrontmatterValue>;
	/** Markdown body, with trailing blank lines normalized away. */
	body: string;
}

export class VaultDocumentParseError extends Error {}

const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

/** A single `[[target]]` / `[[target|label]]` reference, as written in the source text. */
export interface WikilinkRef {
	/** The link target inside the brackets, trimmed. */
	target: string;
	/** The display label after a `|`, trimmed; omitted when absent or blank. */
	label?: string;
}

export function parseVaultDocument(raw: string): VaultDocument {
	const parsed = matter(raw);
	const data = parsed.data as Record<string, unknown>;

	const id = data._id;
	if (typeof id !== "string" || id.length === 0) {
		throw new VaultDocumentParseError("vault document is missing a string `_id` frontmatter field");
	}
	const type = data.type;
	if (typeof type !== "string" || type.length === 0) {
		throw new VaultDocumentParseError("vault document is missing a string `type` frontmatter field");
	}

	const frontmatter: Record<string, VaultFrontmatterValue> = {};
	for (const [key, value] of Object.entries(data)) {
		if (key === "_id" || key === "type") {
			continue;
		}
		frontmatter[key] = coerceFrontmatterValue(value);
	}

	return { id, type, frontmatter, body: stripTrailingNewlines(parsed.content) };
}

export function serializeVaultDocument(doc: VaultDocument): string {
	// Identity first, then the remaining keys in a stable (code-unit) order so
	// writes are byte-deterministic and produce meaningful git diffs.
	const ordered: Record<string, VaultFrontmatterValue> = { _id: doc.id, type: doc.type };
	for (const key of Object.keys(doc.frontmatter).sort()) {
		ordered[key] = doc.frontmatter[key];
	}
	return matter.stringify(stripTrailingNewlines(doc.body), ordered);
}

/**
 * Parse every `[[target]]` / `[[target|label]]` reference out of a single string,
 * in document order, preserving repeats. This is the low-level primitive the link
 * engine builds on; callers that need de-duplication or source attribution layer
 * it on top (see {@link extractWikilinks} and the vault link index).
 */
export function extractWikilinkRefs(text: string): WikilinkRef[] {
	const refs: WikilinkRef[] = [];
	for (const match of text.matchAll(WIKILINK_PATTERN)) {
		const target = match[1].trim();
		if (target.length === 0) {
			continue;
		}
		const label = match[2]?.trim();
		refs.push(label ? { target, label } : { target });
	}
	return refs;
}

/** Collect `[[target]]` (and `[[target|label]]`) targets from a frontmatter value, de-duped, first-seen order. */
export function extractWikilinks(value: VaultFrontmatterValue): string[] {
	const texts: string[] = [];
	if (typeof value === "string") {
		texts.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === "string") {
				texts.push(item);
			}
		}
	}

	const seen = new Set<string>();
	const targets: string[] = [];
	for (const text of texts) {
		for (const { target } of extractWikilinkRefs(text)) {
			if (!seen.has(target)) {
				seen.add(target);
				targets.push(target);
			}
		}
	}
	return targets;
}

/** Build a human-readable, filesystem-safe slug, preserving unicode letters (e.g. Chinese). */
export function slugify(title: string): string {
	const slug = title
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "untitled";
}

function coerceFrontmatterValue(value: unknown): VaultFrontmatterValue {
	if (value === null || value === undefined) {
		return value === undefined ? null : value;
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(coerceScalar);
	}
	return coerceScalar(value);
}

function coerceScalar(value: unknown): string | number | boolean {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	return String(value);
}

function stripTrailingNewlines(text: string): string {
	return text.replace(/\n+$/, "");
}
