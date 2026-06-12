import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { RuntimeVaultFrontmatterValue } from "@/runtime/types";

/**
 * Client-side YAML frontmatter split/parse. The document store on the backend is
 * authoritative for stored docs (it returns structured frontmatter), so this
 * module is used where the client itself authors raw markdown-with-frontmatter:
 * the create-from-template flow (templates are `.md` text) and any place that
 * needs to round-trip frontmatter to a string. `yaml` is gated to this module.
 */

export type VaultFrontmatter = Record<string, RuntimeVaultFrontmatterValue>;

export interface ParsedFrontmatter {
	frontmatter: VaultFrontmatter;
	body: string;
}

// Matches a leading `---\n...\n---` block (tolerant of trailing whitespace and a
// single trailing newline before the body).
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/;

/** Coerce an arbitrary parsed YAML value into the permissive frontmatter model. */
function coerceFrontmatter(parsed: unknown): VaultFrontmatter {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const result: VaultFrontmatter = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value === null) {
			result[key] = null;
		} else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			result[key] = value;
		} else if (Array.isArray(value)) {
			result[key] = value
				.filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
				.map((item) => item as string | number | boolean);
		} else {
			// Nested maps are outside the model; mirror the backend by stringifying.
			result[key] = String(value);
		}
	}
	return result;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
	const match = FRONTMATTER_BLOCK.exec(raw);
	if (!match) {
		return { frontmatter: {}, body: raw };
	}
	let frontmatter: VaultFrontmatter = {};
	try {
		frontmatter = coerceFrontmatter(parseYaml(match[1] ?? ""));
	} catch {
		// A malformed block is treated as body text rather than failing the parse.
		return { frontmatter: {}, body: raw };
	}
	return { frontmatter, body: match[2] ?? "" };
}

export function serializeFrontmatter(frontmatter: VaultFrontmatter, body: string): string {
	const keys = Object.keys(frontmatter);
	if (keys.length === 0) {
		return body;
	}
	// Deterministic key order keeps any client-side round-trip diff-stable.
	const ordered: VaultFrontmatter = {};
	for (const key of keys.sort()) {
		ordered[key] = frontmatter[key] as RuntimeVaultFrontmatterValue;
	}
	const yaml = stringifyYaml(ordered).trimEnd();
	return `---\n${yaml}\n---\n\n${body}`;
}
