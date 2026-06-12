import { Fzf } from "fzf";

import type { VaultDoc } from "../data/vault-doc-model";

/** A doc offered in the body autocomplete menu (title + aliases drive matching). */
export interface WikilinkCandidate {
	id: string;
	type: string;
	title: string;
	aliases: string[];
}

const ALIASES_KEY = "aliases";
const DEFAULT_LIMIT = 8;

/** Read the `aliases` frontmatter (string array or single string) as a string list. */
export function vaultDocAliases(doc: VaultDoc): string[] {
	const value = doc.frontmatter[ALIASES_KEY];
	if (typeof value === "string") {
		return value.trim() ? [value] : [];
	}
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string");
	}
	return [];
}

function toCandidate(doc: VaultDoc): WikilinkCandidate {
	return { id: doc.id, type: doc.type, title: doc.name, aliases: vaultDocAliases(doc) };
}

/** Searchable haystack for one candidate: its title plus every alias. */
function haystack(candidate: WikilinkCandidate): string {
	return [candidate.title, ...candidate.aliases].join(" ");
}

export interface SearchWikilinkCandidatesOptions {
	limit?: number;
	/** Drop this doc from the results (a doc never links to itself). */
	excludeId?: string;
}

/**
 * Fuzzy-rank vault docs for the `[[` menu. Matching is a presentation concern, so
 * `fzf` runs client-side over title + aliases (the same lib the customer picker
 * uses); link *resolution* still belongs to the B1 backend engine.
 */
export function searchWikilinkCandidates(
	docs: VaultDoc[],
	query: string,
	options: SearchWikilinkCandidatesOptions = {},
): WikilinkCandidate[] {
	const limit = options.limit ?? DEFAULT_LIMIT;
	const candidates = docs
		.filter((doc) => doc.id !== options.excludeId)
		.map(toCandidate);

	const trimmed = query.trim();
	if (!trimmed) {
		return candidates.slice(0, limit);
	}
	const finder = new Fzf(candidates, { selector: haystack });
	return finder
		.find(trimmed)
		.slice(0, limit)
		.map((result) => result.item);
}
