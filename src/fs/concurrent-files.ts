// Bounded-concurrency file fan-out.
//
// Several hot read/write paths (`readShardDir`/`writeShardDir`, the board's
// `readStoredTasks`/`saveShardedBoard`, the vault `scanAll`/`computeSignature`)
// historically fanned out with a bare `Promise.all(ids.map(read))`. That opens
// one file descriptor per item *simultaneously*, so a workspace that has
// accumulated thousands of task / requirement / vault-doc shards exhausts the
// process fd table the instant it is opened — `EMFILE: too many open files` —
// and the whole runtime crashes. macOS ships a default soft limit of 256 fds and
// many Linux setups default to 1024, so this trips well below "huge" data sizes.
//
// Routing every per-file fan-out through a single shared limiter caps the total
// number of concurrent file operations regardless of how many fan-outs run at
// once (board + requirements + vault all load together on workspace open), while
// staying parallel for throughput. p-limit preserves nothing about ordering, so
// `mapWithLimit` rebuilds the input order with `Promise.all` over the wrapped
// promises (each individual op still runs through the limiter).

import pLimit, { type LimitFunction } from "p-limit";

/** Env var overriding the max number of concurrent file operations. */
export const FILE_CONCURRENCY_ENV = "KANBAN_MAX_FILE_CONCURRENCY";

/**
 * Default ceiling on concurrent file operations. Chosen to stay comfortably under
 * the smallest common soft fd limit (macOS's 256) even when board, requirement and
 * vault fan-outs share the budget at once, while remaining high enough that shard
 * reads stay effectively parallel.
 */
export const DEFAULT_FILE_CONCURRENCY = 48;

/**
 * Resolve the concurrency bound from the raw env value, falling back to
 * {@link DEFAULT_FILE_CONCURRENCY} for an absent, empty, or invalid (non-numeric /
 * non-positive) value. Always returns an integer ≥ 1. Pure for unit testing.
 */
export function resolveFileConcurrency(rawValue: string | undefined): number {
	if (rawValue === undefined) {
		return DEFAULT_FILE_CONCURRENCY;
	}
	const trimmed = rawValue.trim();
	if (trimmed === "") {
		return DEFAULT_FILE_CONCURRENCY;
	}
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed) || parsed < 1) {
		return DEFAULT_FILE_CONCURRENCY;
	}
	return Math.floor(parsed);
}

/**
 * Map `items` through `fn`, running at most `limit` invocations concurrently, and
 * return the results in input order. Pass a shared {@link LimitFunction} to bound
 * several concurrent fan-outs against one global budget. The first rejection
 * rejects the whole call (matching `Promise.all`).
 */
export function mapWithLimit<T, R>(
	items: readonly T[],
	limit: LimitFunction,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	return Promise.all(items.map((item, index) => limit(() => fn(item, index))));
}

/**
 * Process-wide budget shared by every per-file fan-out so their combined in-flight
 * file descriptors can never exhaust the fd table, however many run at once.
 */
const sharedFileLimit: LimitFunction = pLimit(resolveFileConcurrency(process.env[FILE_CONCURRENCY_ENV]));

/**
 * Map `items` through `fn` under the process-wide file-concurrency budget,
 * returning results in input order. Use this for any fan-out that opens one file
 * descriptor per item (shard reads/writes, vault doc scans).
 */
export function mapFilesConcurrent<T, R>(
	items: readonly T[],
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	return mapWithLimit(items, sharedFileLimit, fn);
}
