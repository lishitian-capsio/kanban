// The single source for the "this 会话-agent is active/selected" visual signal,
// per the unification decision (vault `decision/d746c`, rule 2): accent is the
// shared signal everywhere; only its *shape* adapts to the container.
//
//   - tile contexts (the launcher card) → an accent **border**.
//   - linear-row contexts (tab / dropdown item / rail item) → an accent **bar**
//     (a bottom underline for the horizontal tab strip, a left bar for the
//     vertical dropdown/rail lists) plus the `surface-2` active background.
//
// Inactive rows reserve the same 2px border in `transparent` so toggling active
// never shifts the row's content. Kept as a pure function so the rule lives in one
// place and is unit-testable.

export type ActiveHighlightVariant = "card" | "tab" | "dropdown-item" | "rail-item";

export function getActiveHighlightClass(variant: ActiveHighlightVariant, isActive: boolean): string {
	switch (variant) {
		case "card":
			// Tile: the accent rides the card's own border; the resting border brightens on hover.
			return isActive ? "border-accent hover:border-accent" : "border-border hover:border-border-bright";
		case "tab":
			// Horizontal strip: accent underline + raised background when active.
			return isActive
				? "border-b-2 border-accent bg-surface-2 text-text-primary"
				: "border-b-2 border-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary";
		default:
			// Vertical lists (dropdown item / rail item): accent left bar + raised background.
			return isActive
				? "border-l-2 border-accent bg-surface-2 text-text-primary"
				: "border-l-2 border-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary";
	}
}
