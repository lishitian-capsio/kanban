import type { VaultColumnSpec, VaultTypeView } from "../data/vault-type-registry";

/**
 * The table columns a view actually renders. An empty `listPropertiesDisplay`
 * means "the type's default columns"; otherwise the title column is always shown
 * first, followed by the chosen frontmatter columns in the user's order.
 */
export function effectiveColumns(view: VaultTypeView, listPropertiesDisplay: string[]): VaultColumnSpec[] {
	if (listPropertiesDisplay.length === 0) {
		return view.columns;
	}
	const byKey = new Map(view.columns.map((column) => [column.key, column]));
	const titleColumn = view.columns.find((column) => column.kind === "title");
	const chosen = listPropertiesDisplay
		.filter((key) => key !== titleColumn?.key)
		.map((key) => byKey.get(key))
		.filter((column): column is VaultColumnSpec => column !== undefined);
	return titleColumn ? [titleColumn, ...chosen] : chosen;
}

/** A view of the type with its columns overridden — passed to the reused table view. */
export function withEffectiveColumns(view: VaultTypeView, listPropertiesDisplay: string[]): VaultTypeView {
	const columns = effectiveColumns(view, listPropertiesDisplay);
	return columns === view.columns ? view : { ...view, columns };
}
