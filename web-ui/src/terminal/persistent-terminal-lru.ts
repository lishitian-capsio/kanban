// Pure LRU bookkeeping for the persistent-terminal cache. Kept separate from
// `persistent-terminal-manager.ts` so it can be unit-tested without importing
// xterm (which touches canvas/WebGL on load).

/**
 * Max number of persistent terminals retained across all workspaces. Mounted
 * (visible) terminals are never evicted, so the live count can briefly exceed
 * this when many terminals are on screen at once; the cap bounds the docked
 * backlog that would otherwise grow without limit as tasks are visited. Each
 * retained terminal holds a live xterm buffer (10k scrollback), a WebGL
 * context, addons, and two open WebSockets — scarce resources worth bounding.
 */
export const MAX_PERSISTENT_TERMINALS = 5;

/**
 * Decide which terminals to evict, given the current set in LRU order
 * (oldest → newest). Mounted terminals and the just-ensured `keepKey` are never
 * evicted; the oldest docked terminals are dropped until the retained count is
 * within `max` (or no more are evictable).
 */
export function planLruTerminalEvictions(
	entries: ReadonlyArray<{ key: string; isMounted: boolean }>,
	keepKey: string,
	max: number,
): string[] {
	const toEvict: string[] = [];
	let retained = entries.length;
	for (const entry of entries) {
		if (retained <= max) {
			break;
		}
		if (entry.key === keepKey || entry.isMounted) {
			continue;
		}
		toEvict.push(entry.key);
		retained -= 1;
	}
	return toEvict;
}
