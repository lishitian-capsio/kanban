import { createLogger } from "../../logging";
import type { DatabaseService } from "../db-service";
import { DbConnectionError } from "../errors";
import { classifySql } from "../policy/sql-classifier";
import type { ConnectionRecord } from "../registry/connection-store";
import type { DbCaller, FieldInfo, QueryResult, SqlClassification } from "../types";
import { buildBoundedQuery, capRowsByBytes, finalizePage } from "./query-bounds";
import { runWithDeadline } from "./query-deadline";
import { normalizeQueryError, QueryExecutionError } from "./query-error-normalizer";
import { getQueryConcurrencyLimiter, type QueryConcurrencyLimiter } from "./query-limiter";

const log = createLogger("db:query-executor");

/** Hard limits enforced on every execution. Overridable per-instance and per-query. */
export interface QueryExecutionLimits {
	/** Page size used for reads when the caller doesn't specify one. */
	defaultPageSize: number;
	/** Hard cap on rows returned in one page (clamps page size and post-fetch row count). */
	maxRows: number;
	/** Hard cap on the serialized byte size of a returned page. */
	maxBytes: number;
	/** Per-query execution timeout in ms (0 disables). */
	timeoutMs: number;
}

export const DEFAULT_QUERY_EXECUTION_LIMITS: QueryExecutionLimits = {
	defaultPageSize: 1000,
	maxRows: 10_000,
	maxBytes: 8 * 1024 * 1024,
	timeoutMs: 30_000,
};

export interface QueryExecutorDeps {
	/**
	 * The policy chokepoint. The executor never talks to a driver directly — it routes
	 * every statement through {@link DatabaseService.runQuery}, so secret resolution and
	 * the access policy cannot be bypassed. {@link DatabaseService.invalidate} is the
	 * teardown used to abandon a timed-out / cancelled connection.
	 */
	service: Pick<DatabaseService, "runQuery" | "invalidate">;
	/** Resolve a connection's record (the executor needs its engine to classify + bound). */
	loadConnection: (connId: string) => Promise<ConnectionRecord | null>;
	/** Concurrency throttle. Defaults to the host-wide singleton. */
	limiter?: QueryConcurrencyLimiter;
	/** Instance-level limit overrides merged over {@link DEFAULT_QUERY_EXECUTION_LIMITS}. */
	limits?: Partial<QueryExecutionLimits>;
	/** Injectable clock for total-duration measurement. */
	now?: () => number;
}

export interface ExecuteQueryInput {
	connId: string;
	sql: string;
	caller: DbCaller;
	params?: ReadonlyArray<unknown>;
	/** Pagination intent for reads. Ignored for writes. */
	page?: { pageSize?: number; cursor?: string | null };
	/** Per-query limit overrides. */
	limits?: Partial<QueryExecutionLimits>;
	/** Cancellation signal. */
	signal?: AbortSignal;
}

export interface ExecuteQueryPagination {
	/** Whether server-side LIMIT bounding was applied (true for reads). */
	paginated: boolean;
	pageSize: number;
	hasMore: boolean;
	/** Opaque token to fetch the next page, or null when there is none. */
	nextCursor: string | null;
}

export interface ExecuteQueryResult {
	/** Column definitions for the returned rows. */
	columns: FieldInfo[];
	rows: Array<Record<string, unknown>>;
	/** Rows returned in this page. */
	rowCount: number;
	/** Rows affected by a write/DDL statement; null for reads. */
	affectedRows: number | null;
	classification: SqlClassification;
	readOnly: boolean;
	/** DB-reported execution time in ms. */
	durationMs: number;
	/** Wall-clock time including concurrency queue wait, in ms. */
	totalDurationMs: number;
	pagination: ExecuteQueryPagination;
	truncated: { byRows: boolean; byBytes: boolean };
}

/**
 * The query-execution backend the three upper entries (agent / human / cli) share. It sits
 * on top of {@link DatabaseService} (the policy chokepoint) and adds the bounded, safe
 * execution every caller needs: server-side LIMIT bounding so a large result set never
 * lands in runtime memory, opaque-cursor pagination, per-connection + host-wide concurrency
 * throttling, a query timeout with connection teardown so a runaway query can't hang the
 * runtime, row/byte caps, and normalized errors that never leak connection secrets.
 *
 * It does NOT stream row-by-row (the core driver materializes results and the executor
 * reuses that interface) — the memory guarantee comes from bounding the result at the
 * database via the LIMIT wrapper. Per-row streaming would require extending the driver
 * interface and is a separate follow-up.
 */
export class QueryExecutor {
	private readonly limiter: QueryConcurrencyLimiter;
	private readonly limits: QueryExecutionLimits;
	private readonly now: () => number;

	constructor(private readonly deps: QueryExecutorDeps) {
		this.limiter = deps.limiter ?? getQueryConcurrencyLimiter();
		this.limits = { ...DEFAULT_QUERY_EXECUTION_LIMITS, ...deps.limits };
		this.now = deps.now ?? Date.now;
	}

	async execute(input: ExecuteQueryInput): Promise<ExecuteQueryResult> {
		const started = this.now();
		try {
			return await this.limiter.run(input.connId, () => this.runBounded(input, started));
		} catch (error) {
			if (error instanceof QueryExecutionError) {
				throw error;
			}
			const normalized = normalizeQueryError(error);
			log.debug("query failed", { connId: input.connId, caller: input.caller, code: normalized.code, error });
			throw new QueryExecutionError(normalized, { cause: error });
		}
	}

	private async runBounded(input: ExecuteQueryInput, started: number): Promise<ExecuteQueryResult> {
		const limits = { ...this.limits, ...input.limits };
		const record = await this.deps.loadConnection(input.connId);
		if (!record) {
			throw new DbConnectionError(`unknown connection: "${input.connId}"`);
		}

		const classification = classifySql(input.sql, record.engine);
		const pageSize = clampPageSize(input.page?.pageSize ?? limits.defaultPageSize, limits.maxRows);
		const bounded = buildBoundedQuery({
			sql: input.sql,
			classification,
			page: { pageSize, cursor: input.page?.cursor },
		});

		const driverResult = await runWithDeadline(
			() =>
				this.deps.service.runQuery({
					connId: input.connId,
					sql: bounded.sql,
					caller: input.caller,
					params: input.params,
				}),
			{
				timeoutMs: limits.timeoutMs,
				signal: input.signal,
				onAbandon: (reason) => {
					// Drop the pooled driver so the runaway query's sockets are torn down and
					// the runtime regains control immediately.
					log.warn("abandoning query; tearing down connection", { connId: input.connId, reason });
					void this.deps.service.invalidate(input.connId);
				},
			},
		);

		return this.shapeResult({ input, started, classification, pageSize, bounded, driverResult, limits });
	}

	private shapeResult(args: {
		input: ExecuteQueryInput;
		started: number;
		classification: SqlClassification;
		pageSize: number;
		bounded: ReturnType<typeof buildBoundedQuery>;
		driverResult: QueryResult;
		limits: QueryExecutionLimits;
	}): ExecuteQueryResult {
		const { classification, pageSize, bounded, driverResult, limits } = args;
		const readOnly = classification === "read";

		let rows = driverResult.rows;
		let hasMore = false;
		let nextCursor: string | null = null;
		let truncatedByRows = false;
		let truncatedByBytes = false;

		if (bounded.wrapped) {
			const page = finalizePage(driverResult.rows, { pageSize, offset: bounded.offset, maxBytes: limits.maxBytes });
			rows = page.rows;
			hasMore = page.hasMore;
			nextCursor = page.nextCursor;
			truncatedByBytes = page.truncatedByBytes;
		} else {
			// Writes / unparseable statements aren't server-bounded; apply post-fetch caps as a
			// safety net for large RETURNING payloads.
			if (rows.length > limits.maxRows) {
				rows = rows.slice(0, limits.maxRows);
				truncatedByRows = true;
			}
			const capped = capRowsByBytes(rows, limits.maxBytes);
			rows = capped.rows;
			truncatedByBytes = capped.truncated;
		}

		return {
			columns: driverResult.fields,
			rows,
			rowCount: rows.length,
			affectedRows: readOnly ? null : driverResult.rowCount,
			classification,
			readOnly,
			durationMs: driverResult.durationMs,
			totalDurationMs: this.now() - args.started,
			pagination: { paginated: bounded.wrapped, pageSize, hasMore, nextCursor },
			truncated: { byRows: truncatedByRows, byBytes: truncatedByBytes },
		};
	}
}

function clampPageSize(requested: number, maxRows: number): number {
	const cap = Math.max(1, Math.trunc(maxRows));
	const value = Math.trunc(requested);
	if (!Number.isFinite(value) || value < 1) {
		return Math.min(cap, 1);
	}
	return Math.min(value, cap);
}
