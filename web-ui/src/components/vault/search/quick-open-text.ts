import type { VaultDoc } from "../data/vault-doc-model";

/**
 * The string the quick-open palette fuzzy-matches against: a document's title plus
 * any `aliases` declared in frontmatter (a string or an array of strings). Pure, so
 * the fzf selector stays trivially testable.
 */
export function quickOpenSearchText(doc: VaultDoc): string {
	const parts = [doc.name];
	const aliases = doc.frontmatter.aliases;
	if (typeof aliases === "string") {
		parts.push(aliases);
	} else if (Array.isArray(aliases)) {
		for (const alias of aliases) {
			if (typeof alias === "string") {
				parts.push(alias);
			}
		}
	}
	return parts.join(" ");
}
