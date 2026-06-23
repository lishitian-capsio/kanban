import { availableParallelism, cpus } from "node:os";
import pLimit, { type LimitFunction } from "p-limit";

import { createLogger } from "../../logging";

const log = createLogger("db:query-limiter");

/** Env var overriding the host-wide max number of queries run concurrently. */
export const QUERY_CONCURRENCY_ENV = "KANBAN_DB_MAX_CONCURRENT_QUERIES";
/** Env var overriding the per-connection max number of queries run concurrently. */
export const QUERY_PER_CONNECTION_CONCURRENCY_ENV = "KANBAN_DB_MAX_CONCURRENT_QUERIES_PER_CONNECTION";

/** Default queries in flight per connection when nothing is configured. */
const DEFAULT_PER_CONNECTION_CONCURRENCY = 4;

export interface QueryConcurrencyLimiter {
	/** Run `fn` once both a per-connection and a host-wide slot are free; queues otherwise. */
	run<T>(connId: string, fn: () => Promise<T>): Promise<T>;
	readonly hostConcurrency: number;
	readonly perConnectionConcurrency: number;
}

export interface QueryConcurrencyOptions {
	hostConcurrency: number;
	perConnectionConcurrency: number;
}

/**
 * Resolve a configured concurrency from a raw env value, falling back to `fallback` for an
 * absent, empty, or invalid (non-numeric / non-positive) value. Returns an integer ≥ 1.
 */
export function resolveConcurrency(rawValue: string | undefined, fallback: number): number {
	const safeFallback = Math.max(1, Math.floor(fallback));
	if (rawValue === undefined) {
		return safeFallback;
	}
	const trimmed = rawValue.trim();
	if (trimmed === "") {
		return safeFallback;
	}
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed) || parsed < 1) {
		return safeFallback;
	}
	return Math.floor(parsed);
}

/**
 * Two-level query throttle. A query first takes a slot in its connection's limiter, then a
 * slot in the shared host limiter, and only then runs — so one busy connection can't starve
 * the host pool (it waits for its own slot WITHOUT holding a host slot), distinct
 * connections run in parallel, and the host cap bounds total in-flight work.
 */
export function createQueryConcurrencyLimiter(options: QueryConcurrencyOptions): QueryConcurrencyLimiter {
	const hostConcurrency = Math.max(1, Math.floor(options.hostConcurrency));
	const perConnectionConcurrency = Math.max(1, Math.floor(options.perConnectionConcurrency));
	const hostLimit: LimitFunction = pLimit(hostConcurrency);
	const perConnection = new Map<string, LimitFunction>();

	const connLimit = (connId: string): LimitFunction => {
		let limit = perConnection.get(connId);
		if (!limit) {
			limit = pLimit(perConnectionConcurrency);
			perConnection.set(connId, limit);
		}
		return limit;
	};

	return {
		run: (connId, fn) => connLimit(connId)(() => hostLimit(fn)),
		hostConcurrency,
		perConnectionConcurrency,
	};
}

function resolveHostCpuCount(): number {
	try {
		return availableParallelism();
	} catch {
		return cpus().length;
	}
}

let sharedLimiter: QueryConcurrencyLimiter | null = null;

/** Lazily-initialized, host-wide singleton query limiter (env- and CPU-derived). */
export function getQueryConcurrencyLimiter(): QueryConcurrencyLimiter {
	if (!sharedLimiter) {
		const hostConcurrency = resolveConcurrency(
			process.env[QUERY_CONCURRENCY_ENV],
			Math.max(4, resolveHostCpuCount()),
		);
		const perConnectionConcurrency = resolveConcurrency(
			process.env[QUERY_PER_CONNECTION_CONCURRENCY_ENV],
			DEFAULT_PER_CONNECTION_CONCURRENCY,
		);
		sharedLimiter = createQueryConcurrencyLimiter({ hostConcurrency, perConnectionConcurrency });
		log.info("Query concurrency limiter initialized", { hostConcurrency, perConnectionConcurrency });
	}
	return sharedLimiter;
}
