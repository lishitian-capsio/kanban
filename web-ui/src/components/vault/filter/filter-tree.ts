import type { RuntimeVaultFilterCondition, RuntimeVaultFilterGroup, RuntimeVaultFilterNode } from "@/runtime/types";

/** Pure helpers for reading and rewriting the recursive filter group tree. */

export type Combinator = "all" | "any";

export function isFilterGroup(node: RuntimeVaultFilterNode): node is RuntimeVaultFilterGroup {
	return "all" in node || "any" in node;
}

export function groupCombinator(group: RuntimeVaultFilterGroup): Combinator {
	return "all" in group ? "all" : "any";
}

export function groupChildren(group: RuntimeVaultFilterGroup): RuntimeVaultFilterNode[] {
	return "all" in group ? group.all : group.any;
}

export function withChildren(combinator: Combinator, children: RuntimeVaultFilterNode[]): RuntimeVaultFilterGroup {
	return combinator === "all" ? { all: children } : { any: children };
}

export const EMPTY_GROUP: RuntimeVaultFilterGroup = { all: [] };

export function newCondition(field: string): RuntimeVaultFilterCondition {
	return { field, op: "equals", value: "" };
}

/** Total number of leaf conditions in the tree (drives the active-filter badge). */
export function countConditions(group: RuntimeVaultFilterGroup): number {
	return groupChildren(group).reduce((total, node) => total + (isFilterGroup(node) ? countConditions(node) : 1), 0);
}
