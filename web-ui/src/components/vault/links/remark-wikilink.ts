import type { Link, Root } from "mdast";
import { findAndReplace, type ReplaceFunction } from "mdast-util-find-and-replace";

/**
 * Internal href scheme used to smuggle a wikilink target through react-markdown's
 * standard link pipeline. The plugin rewrites `[[target|label]]` into a normal
 * mdast `link` node whose url is `wikilink:<encoded-target>`; the markdown
 * renderer's `a` override detects the scheme and swaps in the interactive chip.
 * Reusing the link node (instead of a bespoke mdast/hast type) keeps us on the
 * supported react-markdown path with no custom node registration.
 */
export const WIKILINK_SCHEME = "wikilink:";

// `[[target]]` or `[[target|label]]`, single-line, non-greedy and pipe-aware.
const WIKILINK_PATTERN = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;

/** Decode the target from a `wikilink:` href, or null for ordinary links. */
export function parseWikilinkHref(href: string | undefined | null): string | null {
	if (!href || !href.startsWith(WIKILINK_SCHEME)) {
		return null;
	}
	try {
		return decodeURIComponent(href.slice(WIKILINK_SCHEME.length));
	} catch {
		return href.slice(WIKILINK_SCHEME.length);
	}
}

const replaceWikilink: ReplaceFunction = (_match, target: string, label?: string) => {
	const trimmedTarget = target.trim();
	const text = (label ?? target).trim();
	const node: Link = {
		type: "link",
		url: `${WIKILINK_SCHEME}${encodeURIComponent(trimmedTarget)}`,
		title: null,
		children: [{ type: "text", value: text }],
	};
	return node;
};

/** remark plugin: turn body `[[wikilinks]]` into renderable link nodes. */
export function remarkWikilink(): (tree: Root) => void {
	return (tree) => {
		findAndReplace(tree, [[WIKILINK_PATTERN, replaceWikilink]]);
	};
}
