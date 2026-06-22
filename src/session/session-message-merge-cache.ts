// Per-task memoization for `mergeSessionMessages`.
//
// Resolving a task transcript (`loadTaskSessionMessages`) merges the durable
// journal with the live in-memory buffer on every read. Both the file read and
// the O(n) merge are wasted work when neither side changed since the last read —
// the common case when a chat panel re-opens or re-fetches a quiescent session
// with hundreds of messages.
//
// This cache skips both when a cheap change token is unchanged. The token has
// two parts, mirroring the two merge inputs:
//   - the journal's per-task generation (advances on record/clear, stable across
//     reads and content-preserving compaction), and
//   - a signature of the live buffer (length + the trailing message's id and
//     content). Every buffer mutation is paired with a journal `recordMessage`,
//     so the generation already covers mid-transcript edits (e.g. a tool result
//     folded into a non-trailing message); the live signature is a cheap extra
//     guard that also reflects the streaming tail as it grows.
//
// A cache hit returns the previously merged array without reading the file or
// re-running the merge loop. Entries are keyed by taskId and isolated per cache
// instance, so one cache per workspace-scoped service keeps workspaces separate.
import type { SessionMessage } from "./session-message";
import { mergeSessionMessages } from "./session-message-journal";

interface MergeCacheEntry {
	persistedGeneration: number;
	liveLength: number;
	lastId: string | null;
	lastContent: string | null;
	merged: SessionMessage[];
}

function lastOf(live: SessionMessage[]): SessionMessage | null {
	return live.at(-1) ?? null;
}

export class SessionMessageMergeCache {
	private readonly entries = new Map<string, MergeCacheEntry>();

	/**
	 * Return the merged transcript for a task, reusing the cached result when the
	 * persisted generation and the live buffer are both unchanged. `loadPersisted`
	 * is only invoked on a miss, so a hit performs no file I/O.
	 */
	async resolve(
		taskId: string,
		persistedGeneration: number,
		live: SessionMessage[],
		loadPersisted: () => Promise<SessionMessage[]>,
	): Promise<SessionMessage[]> {
		const last = lastOf(live);
		const cached = this.entries.get(taskId);
		if (
			cached &&
			cached.persistedGeneration === persistedGeneration &&
			cached.liveLength === live.length &&
			cached.lastId === (last?.id ?? null) &&
			cached.lastContent === (last?.content ?? null)
		) {
			return cached.merged;
		}

		const persisted = await loadPersisted();
		const merged = mergeSessionMessages(persisted, live);
		this.entries.set(taskId, {
			persistedGeneration,
			liveLength: live.length,
			lastId: last?.id ?? null,
			lastContent: last?.content ?? null,
			merged,
		});
		return merged;
	}

	/** Drop the cached merge for a task (e.g. when its session is closed). */
	invalidate(taskId: string): void {
		this.entries.delete(taskId);
	}
}
