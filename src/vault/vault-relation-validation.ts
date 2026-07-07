import type { RuntimeVaultOutgoingLink } from "../core/api-contract";
import type { VaultLinkIndex } from "./vault-link-index";
import type { VaultRelationDefinition, VaultTypeDefinition } from "./vault-types";

/** The three ways a declared typed relation can disagree with the links actually authored. */
export type VaultRelationIssueKind = "target-type-mismatch" | "cardinality" | "dangling";

/**
 * One advisory finding about a document's typed relations. Purely diagnostic — the
 * validator NEVER blocks a save; a UI may surface these as hints. `relation` is the
 * relation/field name it concerns; `detail` is a human-readable explanation.
 */
export interface VaultRelationIssue {
	relation: string;
	kind: VaultRelationIssueKind;
	detail: string;
}

/** The minimal document shape the validator needs: just enough to query the link index. */
export interface VaultRelationDocument {
	id: string;
}

/**
 * Validate a document's typed relations against its type definition, using the
 * already-built link index (which tags every outgoing link with its `source.field`
 * and `resolvedType`). This is a **pure, advisory** check — it returns issues, never
 * throws, and must never gate a save.
 *
 * Only frontmatter fields whose name matches a *declared* relation on the type are
 * considered; undeclared frontmatter fields and body links stay untyped mentions and
 * are ignored, so documents authored before a type grew relations validate cleanly
 * (fully backward-compatible). For each declared relation we flag:
 *
 * - `target-type-mismatch` — a resolved link whose `resolvedType` is outside the
 *   relation's `target` whitelist (an omitted target or `"*"` means "any type");
 * - `cardinality` — `cardinality: "one"` but the field holds more than one link;
 * - `dangling` — a link in the field whose `resolvedId` is null (resolves to nothing).
 */
export function validateDocumentRelations(
	doc: VaultRelationDocument,
	typeDef: VaultTypeDefinition,
	linkIndex: VaultLinkIndex,
): VaultRelationIssue[] {
	const relations = typeDef.relations;
	if (!relations) {
		return [];
	}

	const outgoing = linkIndex.outgoing(doc.id);
	const issues: VaultRelationIssue[] = [];

	for (const [name, relation] of Object.entries(relations)) {
		const links = outgoing.filter((link) => link.source.kind === "frontmatter" && link.source.field === name);
		if (links.length === 0) {
			continue;
		}
		collectRelationIssues(name, relation, links, issues);
	}

	return issues;
}

function collectRelationIssues(
	name: string,
	relation: VaultRelationDefinition,
	links: RuntimeVaultOutgoingLink[],
	issues: VaultRelationIssue[],
): void {
	if (relation.cardinality === "one" && links.length > 1) {
		issues.push({
			relation: name,
			kind: "cardinality",
			detail: `relation "${name}" allows one target but has ${links.length}`,
		});
	}

	const whitelist = normalizeTargetWhitelist(relation.target);
	for (const link of links) {
		if (link.resolvedId === null) {
			issues.push({
				relation: name,
				kind: "dangling",
				detail: `relation "${name}" links to "${link.target}", which resolves to no document`,
			});
			continue;
		}
		if (whitelist && link.resolvedType !== null && !whitelist.has(link.resolvedType)) {
			issues.push({
				relation: name,
				kind: "target-type-mismatch",
				detail: `relation "${name}" links to "${link.target}" of type "${link.resolvedType}", not in [${[...whitelist].join(", ")}]`,
			});
		}
	}
}

/**
 * Normalize a relation's `target` into the set of allowed type ids, or `null` when
 * any type is allowed (target omitted, or `"*"` present as a scalar or array member).
 */
function normalizeTargetWhitelist(target: VaultRelationDefinition["target"]): Set<string> | null {
	if (target === undefined) {
		return null;
	}
	const values = Array.isArray(target) ? target : [target];
	if (values.length === 0 || values.includes("*")) {
		return null;
	}
	return new Set(values);
}
