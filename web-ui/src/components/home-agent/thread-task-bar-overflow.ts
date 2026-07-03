// Pure overflow math for the single-line, non-scrolling thread task bar.
//
// The bar lays out chips left-to-right with a fixed trailing "⋯" overflow button:
//   [chip] gap [chip] gap … [chip] gap [⋯]
// Given each chip's measured width and the container width, this returns how many
// leading chips fit inline; the rest live only in the overflow dialog. The overflow
// button is ALWAYS reserved (it is a persistent affordance for the full list), so a
// gap is counted after every visible chip (the last one's gap sits before the button).

/**
 * @param chipWidths     measured resting widths of each chip, in board order
 * @param containerWidth available inline width for chips + gaps + overflow button
 * @param gap            horizontal gap between adjacent items
 * @param overflowWidth  reserved width of the trailing overflow button
 * @returns number of leading chips that fit inline (0..chipWidths.length)
 */
export function computeVisibleChipCount(
	chipWidths: readonly number[],
	containerWidth: number,
	gap: number,
	overflowWidth: number,
): number {
	// Not measured yet (0/NaN width): show everything so nothing flickers hidden on
	// first paint; the layout effect re-runs with a real width immediately after.
	if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
		return chipWidths.length;
	}
	let used = 0;
	let count = 0;
	for (const width of chipWidths) {
		// Each chip consumes its width plus a trailing gap (to the next chip, or to
		// the overflow button after the final visible chip).
		const nextUsed = used + width + gap;
		if (nextUsed + overflowWidth > containerWidth) {
			break;
		}
		used = nextUsed;
		count += 1;
	}
	return count;
}
