import { generateNKeysBetween } from "fractional-indexing";

/**
 * Compute fractional rank strings for the tasks of a single column, preserving as
 * many existing ranks as possible so that a write touches the fewest task files.
 *
 * Ranks are lexicographically ordered strings (see `fractional-indexing`): sorting
 * tasks by rank reproduces `orderedTaskIds`. A task keeps its stored rank whenever
 * that rank still sits strictly after the previous kept rank; otherwise (a new task,
 * or one whose move broke monotonicity) it gets a fresh rank minted between its
 * neighbours. Appends, single moves, and inserts therefore re-rank only the task
 * that actually moved — the rest stay byte-identical, which is what keeps the
 * per-task files free of git merge conflicts.
 */
export function reconcileColumnRanks(
	orderedTaskIds: readonly string[],
	existingRanks: ReadonlyMap<string, string>,
): Map<string, string> {
	const result = new Map<string, string>();

	// Pass 1: pick the anchors — tasks whose stored rank is still strictly
	// increasing in the desired order. These keep their exact rank string.
	const keep = orderedTaskIds.map(() => false);
	let lastKeptRank: string | null = null;
	for (let index = 0; index < orderedTaskIds.length; index += 1) {
		const taskId = orderedTaskIds[index] as string;
		const rank = existingRanks.get(taskId);
		if (rank !== undefined && (lastKeptRank === null || rank > lastKeptRank)) {
			keep[index] = true;
			lastKeptRank = rank;
		}
	}

	// Pass 2: walk the order, emitting anchors as-is and minting fresh ranks for
	// each run of non-anchor tasks between the surrounding anchors.
	let index = 0;
	while (index < orderedTaskIds.length) {
		const taskId = orderedTaskIds[index] as string;
		if (keep[index]) {
			result.set(taskId, existingRanks.get(taskId) as string);
			index += 1;
			continue;
		}

		// The previous task (if any) is always an anchor we just emitted, so its
		// reconciled rank is the lower bound. Find the next anchor for the upper bound.
		const lowerBound = index > 0 ? (result.get(orderedTaskIds[index - 1] as string) as string) : null;
		let nextAnchor = index;
		while (nextAnchor < orderedTaskIds.length && !keep[nextAnchor]) {
			nextAnchor += 1;
		}
		const upperBound =
			nextAnchor < orderedTaskIds.length
				? (existingRanks.get(orderedTaskIds[nextAnchor] as string) as string)
				: null;

		const freshRanks = generateNKeysBetween(lowerBound, upperBound, nextAnchor - index);
		for (let offset = 0; offset < freshRanks.length; offset += 1) {
			result.set(orderedTaskIds[index + offset] as string, freshRanks[offset] as string);
		}
		index = nextAnchor;
	}

	return result;
}
