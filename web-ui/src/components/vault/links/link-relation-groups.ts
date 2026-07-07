import type { RuntimeVaultBacklink, RuntimeVaultLinkSource, RuntimeVaultOutgoingLink } from "@/runtime/types";

/**
 * A set of links that share one relationship heading. `label` is the human name the
 * links panel shows: a typed relation's declared label when the link's type declares
 * one, else the bare `frontmatter:<field>` / `body` source key (the pre-typed fallback).
 */
export interface VaultLinkGroup<T> {
	/** Stable grouping key (the source key), also the React list key. */
	key: string;
	/** Human heading to render. */
	label: string;
	links: T[];
}

/** The raw source key a link came from — the pre-typed grouping identity and fallback label. */
function sourceKey(source: RuntimeVaultLinkSource): string {
	return source.kind === "frontmatter" ? `frontmatter:${source.field}` : "body";
}

/**
 * Forward-direction heading for an outgoing link: the relation's `label` (falling back
 * to its `name`) when the source type declares the field as a relation, else the bare
 * source key.
 */
export function outgoingLinkLabel(link: RuntimeVaultOutgoingLink): string {
	if (link.relation) {
		return link.relation.label ?? link.relation.name;
	}
	return sourceKey(link.source);
}

/**
 * Reverse-direction heading for a backlink: the relation's `inverseLabel` (falling back
 * to `inverse`, then the forward `label`/`name`) when the linking doc's type declares the
 * field as a relation, else the bare source key.
 */
export function backlinkLabel(link: RuntimeVaultBacklink): string {
	if (link.relation) {
		return link.relation.inverseLabel ?? link.relation.inverse ?? link.relation.label ?? link.relation.name;
	}
	return sourceKey(link.source);
}

/**
 * Group links by their source key (which is 1:1 with a typed relation, since a relation
 * is a frontmatter field), in first-seen order, headed by `labelOf`. Only the heading
 * differs between outgoing and backlinks — the grouping identity is the same source key.
 */
function groupLinks<T extends { source: RuntimeVaultLinkSource }>(
	links: T[],
	labelOf: (link: T) => string,
): VaultLinkGroup<T>[] {
	const groups = new Map<string, VaultLinkGroup<T>>();
	for (const link of links) {
		const key = sourceKey(link.source);
		const group = groups.get(key);
		if (group) {
			group.links.push(link);
		} else {
			groups.set(key, { key, label: labelOf(link), links: [link] });
		}
	}
	return [...groups.values()];
}

export function groupOutgoingLinks(links: RuntimeVaultOutgoingLink[]): VaultLinkGroup<RuntimeVaultOutgoingLink>[] {
	return groupLinks(links, outgoingLinkLabel);
}

export function groupBacklinks(links: RuntimeVaultBacklink[]): VaultLinkGroup<RuntimeVaultBacklink>[] {
	return groupLinks(links, backlinkLabel);
}
