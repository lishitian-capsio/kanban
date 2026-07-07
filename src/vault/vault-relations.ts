import { extractWikilinkRefs, type VaultFrontmatterValue } from "./vault-document";
import { buildVaultLinkResolver, type VaultLinkDocument } from "./vault-link-index";
import type { VaultTypeDefinition } from "./vault-types";

/**
 * The typed-relation query layer (T2/T3) built on the schema declared in each type's
 * `relations` map. It answers two reasoning questions the raw link engine does not:
 * *is a document's typed relation valid* (dangling / wrong target type / over its
 * cardinality) and *what does a relation traverse to* (forward + derived reverse).
 *
 * A relation's name is also the **frontmatter field** that carries its `[[wikilink]]`
 * values, and resolution reuses the exact link-engine resolver ({@link buildVaultLinkResolver}),
 * so a relation resolves identically to any other wikilink. This module never mutates —
 * it only reads a document set + the type definitions.
 */
export type VaultRelationIssueKind = "dangling" | "type_mismatch" | "cardinality";

/** One target of a typed relation, resolved against the vault (or found unresolvable). */
export interface VaultRelationTarget {
	/** The wikilink target (or raw scalar) as written in the frontmatter field. */
	target: string;
	resolvedId: string | null;
	resolvedType: string | null;
	resolvedTitle: string | null;
	/** Set when this specific target is a problem: unresolved, or the wrong target type. */
	issue?: "dangling" | "type_mismatch";
}

/** A typed relation a document declares (via its type), paired with its resolved targets. */
export interface VaultRelationEdge {
	/** Relation name — also the frontmatter field it is read from. */
	relation: string;
	label?: string;
	/** Allowed target type(s) from the definition (omitted / `"*"` ⇒ any). */
	target?: string | string[];
	cardinality: "one" | "many";
	/** Reverse-relation name declared on the target type, for traversal. */
	inverse?: string;
	targets: VaultRelationTarget[];
	/** A single-valued (`cardinality: one`) relation that carries more than one target. */
	cardinalityViolation: boolean;
}

/** A validation finding for one relation on one document. */
export interface VaultRelationIssue {
	docId: string;
	docType: string;
	docTitle: string;
	relation: string;
	kind: VaultRelationIssueKind;
	/** The offending wikilink target (`dangling` / `type_mismatch`). */
	target?: string;
	/** The type the target actually resolved to (`type_mismatch`). */
	resolvedType?: string;
	/** The allowed target type(s) the relation declares (`type_mismatch`). */
	expectedTarget?: string | string[];
	/** How many targets were written (`cardinality`). */
	count?: number;
	message: string;
}

/** A derived reverse edge: a document whose relation resolves TO the queried document. */
export interface VaultRelationInbound {
	relation: string;
	sourceId: string;
	sourceType: string;
	sourceTitle: string;
}

/** One document reached while walking a relation, with the depth and edge that reached it. */
export interface VaultRelationTraversalNode {
	id: string;
	type: string;
	title: string;
	/** Hop distance from the start document (the start node is depth 0). */
	depth: number;
	/** How this node was reached; absent on the start node. */
	via?: { relation: string; fromId: string };
}

export interface VaultRelationTraversalResult {
	start: { id: string; type: string; title: string };
	direction: "forward" | "inverse";
	/** The single relation walked, or null when following every declared relation. */
	relation: string | null;
	maxDepth: number;
	/** Reached documents in breadth-first order (excludes the start node). */
	nodes: VaultRelationTraversalNode[];
	/** Forward targets that resolved to nothing, encountered along the walk (forward only). */
	unresolved: { fromId: string; relation: string; target: string }[];
}

export interface VaultRelationTraversalOptions {
	/** Follow only this relation (forward) / this reverse relation name (inverse). */
	relation?: string;
	/** `forward` follows declared relations out; `inverse` follows derived reverse edges in. */
	direction?: "forward" | "inverse";
	/** Maximum hop distance from the start (default 1). */
	maxDepth?: number;
}

export interface VaultRelationGraph {
	/** Typed relation edges out of a document, in the type definition's declared order. */
	edges(docId: string): VaultRelationEdge[];
	/** Every relation issue across the vault, optionally narrowed by document type / relation name. */
	issues(filter?: { type?: string; relation?: string }): VaultRelationIssue[];
	/** Documents whose relation (optionally a specific one) resolves TO `docId` — the derived reverse edge. */
	inbound(docId: string, relation?: string): VaultRelationInbound[];
	/** Walk relations out of (or into) a document up to a depth — retrieval turned into traversal. Null when the id is unknown. */
	traverse(startId: string, options?: VaultRelationTraversalOptions): VaultRelationTraversalResult | null;
}

/**
 * Build the typed-relation graph over a document set and the type definitions that
 * declare relations. {@link VaultLinkDocument} is structurally the store's runtime
 * document, so `store.list()` feeds straight in.
 */
export function buildVaultRelationGraph(
	documents: VaultLinkDocument[],
	typeDefinitions: VaultTypeDefinition[],
): VaultRelationGraph {
	const resolve = buildVaultLinkResolver(documents);
	const relationsByType = new Map<string, NonNullable<VaultTypeDefinition["relations"]>>();
	for (const definition of typeDefinitions) {
		if (definition.relations) {
			relationsByType.set(definition.type, definition.relations);
		}
	}

	const docById = new Map<string, VaultLinkDocument>();
	for (const document of documents) {
		docById.set(document.id, document);
	}

	const edgesByDoc = new Map<string, VaultRelationEdge[]>();
	for (const document of documents) {
		const relations = relationsByType.get(document.type);
		if (!relations) {
			edgesByDoc.set(document.id, []);
			continue;
		}
		const edges: VaultRelationEdge[] = [];
		for (const [name, definition] of Object.entries(relations)) {
			const cardinality = definition.cardinality ?? "many";
			const targets = relationTargetTexts(document.frontmatter[name]).map((text): VaultRelationTarget => {
				const resolved = resolve(text);
				if (!resolved) {
					return { target: text, resolvedId: null, resolvedType: null, resolvedTitle: null, issue: "dangling" };
				}
				const typeMatches = targetTypeMatches(definition.target, resolved.type);
				return {
					target: text,
					resolvedId: resolved.id,
					resolvedType: resolved.type,
					resolvedTitle: resolved.title,
					...(typeMatches ? {} : { issue: "type_mismatch" as const }),
				};
			});
			edges.push({
				relation: name,
				...(definition.label !== undefined ? { label: definition.label } : {}),
				...(definition.target !== undefined ? { target: definition.target } : {}),
				cardinality,
				...(definition.inverse !== undefined ? { inverse: definition.inverse } : {}),
				targets,
				cardinalityViolation: cardinality === "one" && targets.length > 1,
			});
		}
		edgesByDoc.set(document.id, edges);
	}

	return {
		edges: (docId) => edgesByDoc.get(docId) ?? [],
		issues: (filter) => collectIssues(documents, edgesByDoc, filter),
		inbound: (docId, relation) => collectInbound(documents, edgesByDoc, docId, relation),
		traverse: (startId, options) => traverseRelations(docById, edgesByDoc, documents, startId, options),
	};
}

/**
 * Breadth-first walk of relation edges from a start document, bounded by `maxDepth`
 * (default 1) and guarded against cycles by a visited set. Forward follows a document's
 * declared relations out to their resolved targets; inverse follows the derived reverse
 * edges (documents that point back). A single `relation` narrows the walk.
 */
function traverseRelations(
	docById: Map<string, VaultLinkDocument>,
	edgesByDoc: Map<string, VaultRelationEdge[]>,
	documents: VaultLinkDocument[],
	startId: string,
	options?: VaultRelationTraversalOptions,
): VaultRelationTraversalResult | null {
	const start = docById.get(startId);
	if (!start) {
		return null;
	}
	const direction = options?.direction ?? "forward";
	const relation = options?.relation ?? null;
	const maxDepth = Math.max(1, options?.maxDepth ?? 1);

	const nodes: VaultRelationTraversalNode[] = [];
	const unresolved: VaultRelationTraversalResult["unresolved"] = [];
	const visited = new Set<string>([startId]);
	let frontier: string[] = [startId];

	for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const fromId of frontier) {
			for (const step of stepsFrom(direction, fromId, edgesByDoc, documents, relation)) {
				if (step.resolvedId === null) {
					if (direction === "forward") {
						unresolved.push({ fromId, relation: step.relation, target: step.target });
					}
					continue;
				}
				if (visited.has(step.resolvedId)) {
					continue;
				}
				const reached = docById.get(step.resolvedId);
				if (!reached) {
					continue;
				}
				visited.add(step.resolvedId);
				nodes.push({
					id: reached.id,
					type: reached.type,
					title: reached.title,
					depth,
					via: { relation: step.relation, fromId },
				});
				next.push(reached.id);
			}
		}
		frontier = next;
	}

	return {
		start: { id: start.id, type: start.type, title: start.title },
		direction,
		relation,
		maxDepth,
		nodes,
		unresolved,
	};
}

/** One traversal step out of a node: forward edges' targets, or inverse (reverse) edges' sources. */
function stepsFrom(
	direction: "forward" | "inverse",
	fromId: string,
	edgesByDoc: Map<string, VaultRelationEdge[]>,
	documents: VaultLinkDocument[],
	relation: string | null,
): { relation: string; resolvedId: string | null; target: string }[] {
	if (direction === "forward") {
		const steps: { relation: string; resolvedId: string | null; target: string }[] = [];
		for (const edge of edgesByDoc.get(fromId) ?? []) {
			if (relation && edge.relation !== relation) {
				continue;
			}
			for (const target of edge.targets) {
				steps.push({ relation: edge.relation, resolvedId: target.resolvedId, target: target.target });
			}
		}
		return steps;
	}
	// Inverse: any document whose (optionally named) relation resolves to `fromId`.
	const steps: { relation: string; resolvedId: string | null; target: string }[] = [];
	for (const document of documents) {
		for (const edge of edgesByDoc.get(document.id) ?? []) {
			if (relation && edge.relation !== relation) {
				continue;
			}
			if (edge.targets.some((target) => target.resolvedId === fromId)) {
				steps.push({ relation: edge.relation, resolvedId: document.id, target: document.title });
			}
		}
	}
	return steps;
}

function collectIssues(
	documents: VaultLinkDocument[],
	edgesByDoc: Map<string, VaultRelationEdge[]>,
	filter?: { type?: string; relation?: string },
): VaultRelationIssue[] {
	const issues: VaultRelationIssue[] = [];
	for (const document of documents) {
		if (filter?.type && document.type !== filter.type) {
			continue;
		}
		for (const edge of edgesByDoc.get(document.id) ?? []) {
			if (filter?.relation && edge.relation !== filter.relation) {
				continue;
			}
			const base = { docId: document.id, docType: document.type, docTitle: document.title, relation: edge.relation };
			if (edge.cardinalityViolation) {
				issues.push({
					...base,
					kind: "cardinality",
					count: edge.targets.length,
					message: `relation "${edge.relation}" is single-valued (cardinality: one) but has ${edge.targets.length} targets`,
				});
			}
			for (const target of edge.targets) {
				if (target.issue === "dangling") {
					issues.push({
						...base,
						kind: "dangling",
						target: target.target,
						message: `relation "${edge.relation}" target [[${target.target}]] does not resolve to any document`,
					});
				} else if (target.issue === "type_mismatch") {
					issues.push({
						...base,
						kind: "type_mismatch",
						target: target.target,
						...(target.resolvedType !== null ? { resolvedType: target.resolvedType } : {}),
						...(edge.target !== undefined ? { expectedTarget: edge.target } : {}),
						message: `relation "${edge.relation}" target [[${target.target}]] resolves to a "${target.resolvedType}" but must be ${formatExpectedTarget(edge.target)}`,
					});
				}
			}
		}
	}
	return issues;
}

function collectInbound(
	documents: VaultLinkDocument[],
	edgesByDoc: Map<string, VaultRelationEdge[]>,
	docId: string,
	relation?: string,
): VaultRelationInbound[] {
	const inbound: VaultRelationInbound[] = [];
	for (const document of documents) {
		for (const edge of edgesByDoc.get(document.id) ?? []) {
			if (relation && edge.relation !== relation) {
				continue;
			}
			if (edge.targets.some((target) => target.resolvedId === docId)) {
				inbound.push({
					relation: edge.relation,
					sourceId: document.id,
					sourceType: document.type,
					sourceTitle: document.title,
				});
			}
		}
	}
	return inbound;
}

/**
 * The distinct targets a relation field carries. A `[[wikilink]]` yields its target;
 * a present-but-non-wikilink scalar (a raw id typed by mistake) yields the raw value so
 * it surfaces as a `dangling` relation rather than silently vanishing. De-duped,
 * first-seen order, across a scalar or a scalar array.
 */
function relationTargetTexts(value: VaultFrontmatterValue | undefined): string[] {
	const seen = new Set<string>();
	const targets: string[] = [];
	for (const text of scalarStrings(value)) {
		const refs = extractWikilinkRefs(text).map((ref) => ref.target);
		const candidates = refs.length > 0 ? refs : text.trim().length > 0 ? [text.trim()] : [];
		for (const candidate of candidates) {
			if (!seen.has(candidate)) {
				seen.add(candidate);
				targets.push(candidate);
			}
		}
	}
	return targets;
}

function scalarStrings(value: VaultFrontmatterValue | undefined): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	return [];
}

function targetTypeMatches(allowed: string | string[] | undefined, actual: string): boolean {
	if (allowed === undefined) {
		return true;
	}
	const list = Array.isArray(allowed) ? allowed : [allowed];
	return list.includes("*") || list.includes(actual);
}

function formatExpectedTarget(allowed: string | string[] | undefined): string {
	if (allowed === undefined) {
		return "any type";
	}
	const list = Array.isArray(allowed) ? allowed : [allowed];
	return list.map((type) => `"${type}"`).join(" or ");
}
