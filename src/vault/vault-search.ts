import type {
	RuntimeVaultDocument,
	RuntimeVaultSearchMatchField,
	RuntimeVaultSearchResult,
} from "../core/api-contract";

export interface VaultSearchOptions {
	/** Restrict the search to a single document type (e.g. "requirement"). */
	type?: string;
	/** Cap on the number of ranked results returned. */
	limit?: number;
}

const DEFAULT_LIMIT = 30;

// Position weights: a title hit dominates a frontmatter keyword hit, which in turn
// dominates a body hit. The gaps are wide enough that a single title match always
// outranks any number of body matches, matching the "标题命中 > 正文命中" spec.
const FIELD_BASE: Record<RuntimeVaultSearchMatchField, number> = {
	title: 1000,
	frontmatter: 300,
	body: 100,
};

// Bonuses layered on top of a field's base for a stronger positional match.
const EXACT_BONUS = 500;
const PREFIX_BONUS = 250;
const WORD_BOUNDARY_BONUS = 100;
// Each extra body occurrence nudges the score, capped so body can never overtake
// a higher-tier field.
const BODY_OCCURRENCE_BONUS = 5;
const BODY_OCCURRENCE_CAP = 10;

const SNIPPET_RADIUS = 60;

interface TermFieldMatch {
	field: RuntimeVaultSearchMatchField;
	score: number;
}

/**
 * Score and rank vault documents against a free-text query. Pure and IO-free: the
 * caller scans the doc store and hands the full list in, so this stays trivially
 * unit-testable and reusable. Multi-word queries use AND semantics — every
 * whitespace-separated term must hit somewhere in a document for it to match — and
 * a document's score is the sum of each term's best-field hit. Results are ordered
 * by score (desc), then most-recently-updated, then title.
 */
export function searchVaultDocuments(
	documents: RuntimeVaultDocument[],
	query: string,
	options: VaultSearchOptions = {},
): RuntimeVaultSearchResult[] {
	const terms = tokenize(query);
	if (terms.length === 0) {
		return [];
	}

	const scope = options.type ? documents.filter((d) => d.type === options.type) : documents;

	const scored: RuntimeVaultSearchResult[] = [];
	for (const document of scope) {
		const result = scoreDocument(document, terms);
		if (result) {
			scored.push(result);
		}
	}

	scored.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		if (b.updatedAt !== a.updatedAt) {
			return b.updatedAt - a.updatedAt;
		}
		return a.title.localeCompare(b.title);
	});

	const limit = options.limit ?? DEFAULT_LIMIT;
	return scored.slice(0, limit);
}

function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.map((term) => term.trim())
		.filter((term) => term.length > 0);
}

function scoreDocument(document: RuntimeVaultDocument, terms: string[]): RuntimeVaultSearchResult | null {
	const haystacks = buildHaystacks(document);

	let total = 0;
	let best: TermFieldMatch | null = null;
	for (const term of terms) {
		const match = bestFieldMatch(term, haystacks);
		if (!match) {
			return null; // AND semantics: a missing term disqualifies the document.
		}
		total += match.score;
		if (!best || match.score > best.score) {
			best = match;
		}
	}
	if (!best) {
		return null;
	}

	return {
		id: document.id,
		type: document.type,
		title: document.title,
		relativePath: document.relativePath,
		score: total,
		field: best.field,
		snippet: buildSnippet(document, terms, best.field),
		updatedAt: document.updatedAt,
	};
}

interface Haystacks {
	title: string;
	frontmatter: string;
	body: string;
}

function buildHaystacks(document: RuntimeVaultDocument): Haystacks {
	return {
		title: document.title.toLowerCase(),
		frontmatter: frontmatterText(document).toLowerCase(),
		body: document.body.toLowerCase(),
	};
}

function frontmatterText(document: RuntimeVaultDocument): string {
	const parts: string[] = [];
	for (const value of Object.values(document.frontmatter)) {
		if (value === null) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				parts.push(String(item));
			}
		} else {
			parts.push(String(value));
		}
	}
	return parts.join(" ");
}

function bestFieldMatch(term: string, haystacks: Haystacks): TermFieldMatch | null {
	const candidates: TermFieldMatch[] = [];

	const titleScore = scoreTitle(term, haystacks.title);
	if (titleScore > 0) {
		candidates.push({ field: "title", score: titleScore });
	}
	if (haystacks.frontmatter.includes(term)) {
		candidates.push({
			field: "frontmatter",
			score: FIELD_BASE.frontmatter + (hasWordBoundaryMatch(haystacks.frontmatter, term) ? WORD_BOUNDARY_BONUS : 0),
		});
	}
	const bodyScore = scoreBody(term, haystacks.body);
	if (bodyScore > 0) {
		candidates.push({ field: "body", score: bodyScore });
	}

	if (candidates.length === 0) {
		return null;
	}
	return candidates.reduce((winner, candidate) => (candidate.score > winner.score ? candidate : winner));
}

function scoreTitle(term: string, title: string): number {
	if (!title.includes(term)) {
		return 0;
	}
	let score = FIELD_BASE.title;
	if (title === term) {
		score += EXACT_BONUS;
	} else if (title.startsWith(term)) {
		score += PREFIX_BONUS;
	} else if (hasWordBoundaryMatch(title, term)) {
		score += WORD_BOUNDARY_BONUS;
	}
	return score;
}

function scoreBody(term: string, body: string): number {
	if (!body.includes(term)) {
		return 0;
	}
	const occurrences = countOccurrences(body, term);
	const occurrenceBonus = Math.min((occurrences - 1) * BODY_OCCURRENCE_BONUS, BODY_OCCURRENCE_CAP);
	const boundaryBonus = hasWordBoundaryMatch(body, term) ? WORD_BOUNDARY_BONUS : 0;
	return FIELD_BASE.body + occurrenceBonus + boundaryBonus;
}

function hasWordBoundaryMatch(haystack: string, term: string): boolean {
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(term, from);
		if (index === -1) {
			return false;
		}
		const before = index === 0 ? "" : haystack.charAt(index - 1);
		if (index === 0 || !isWordChar(before)) {
			return true;
		}
		from = index + 1;
	}
}

function isWordChar(char: string): boolean {
	return /[\p{L}\p{N}]/u.test(char);
}

function countOccurrences(haystack: string, term: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(term, from);
		if (index === -1) {
			return count;
		}
		count += 1;
		from = index + term.length;
	}
}

function buildSnippet(document: RuntimeVaultDocument, terms: string[], field: RuntimeVaultSearchMatchField): string {
	if (field === "body") {
		return bodySnippet(document.body, terms);
	}
	if (field === "frontmatter") {
		return collapseWhitespace(frontmatterText(document)).slice(0, SNIPPET_RADIUS * 2);
	}
	return document.title;
}

function bodySnippet(body: string, terms: string[]): string {
	const lower = body.toLowerCase();
	let earliest = -1;
	for (const term of terms) {
		const index = lower.indexOf(term);
		if (index !== -1 && (earliest === -1 || index < earliest)) {
			earliest = index;
		}
	}
	if (earliest === -1) {
		return collapseWhitespace(body).slice(0, SNIPPET_RADIUS * 2);
	}

	const start = Math.max(0, earliest - SNIPPET_RADIUS);
	const end = Math.min(body.length, earliest + SNIPPET_RADIUS);
	const slice = collapseWhitespace(body.slice(start, end));
	const prefix = start > 0 ? "…" : "";
	const suffix = end < body.length ? "…" : "";
	return `${prefix}${slice}${suffix}`;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
