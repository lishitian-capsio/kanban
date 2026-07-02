import { createLogger } from "../../logging";
import type { DatabaseService } from "../db-service";
import { DbConnectionError, InvalidCursorError } from "../errors";
import { classifySql } from "../policy/sql-classifier";
import type { ConnectionRecord } from "../registry/connection-store";
import type { DbCaller, FieldInfo, QueryResult, SqlClassification } from "../types";
import { buildBoundedQuery, capRowsByBytes, finalizePage } from "./query-bounds";
import { runWithDeadline } from "./query-deadline";
import { normalizeQueryError, QueryExecutionError } from "./query-error-normalizer";
import {
	buildKeysetQuery,
	decodeBrowseCursor,
	encodeBrowseCursor,
	encodeKeysetCursor,
	keyValuesOf,
	quoteIdentifier,
	quoteQualifiedTable,
	selectKeysetKey,
} from "./query-keyset";
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
	service: Pick<DatabaseService, "runQuery" | "runGuardedRowWrite" | "invalidate" | "describeTable">;
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

export interface BrowseTableInput {
	connId: string;
	/** Schema/namespace the table lives in. */
	schema: string;
	/** Table (or view) name to browse. */
	table: string;
	caller: DbCaller;
	page?: { pageSize?: number; cursor?: string | null };
	limits?: Partial<QueryExecutionLimits>;
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
			throw this.toExecutionError(input.connId, input.caller, error);
		}
	}

	/**
	 * Browse a table with keyset (seek) pagination — `WHERE (pk) > (lastKey) ORDER BY pk LIMIT n`
	 * — so deep pages stay index-served and flat instead of OFFSET's O(offset) scan. The ordering
	 * key is the table's primary key (resolved via cached introspection); a table without one
	 * falls back to OFFSET. The opaque cursor is self-describing, so the caller pages identically
	 * either way. Shares the executor's concurrency throttle, timeout, teardown, and row/byte caps.
	 */
	async browseTable(input: BrowseTableInput): Promise<ExecuteQueryResult> {
		const started = this.now();
		try {
			return await this.limiter.run(input.connId, () => this.runBrowse(input, started));
		} catch (error) {
			throw this.toExecutionError(input.connId, input.caller, error);
		}
	}

	/**
	 * Execute a single-row write (UPDATE/DELETE) under the guarded, transactional path — the write is
	 * rolled back unless it affects at most one row. Used for edits on tables WITHOUT a primary key,
	 * where the WHERE matches on all original values and a duplicate row could otherwise be
	 * over-affected. Shares the executor's concurrency throttle and normalized errors with
	 * {@link execute}; the transaction and the row guard live in {@link DatabaseService.runGuardedRowWrite}.
	 */
	async executeGuardedRowWrite(input: ExecuteQueryInput): Promise<ExecuteQueryResult> {
		const started = this.now();
		try {
			return await this.limiter.run(input.connId, async () => {
				const limits = { ...this.limits, ...input.limits };
				const driverResult = await this.deps.service.runGuardedRowWrite({
					connId: input.connId,
					sql: input.sql,
					caller: input.caller,
					params: input.params,
					timeoutMs: limits.timeoutMs,
				});
				return {
					columns: driverResult.fields,
					rows: [],
					rowCount: 0,
					affectedRows: driverResult.rowCount,
					classification: "write" as const,
					readOnly: false,
					durationMs: driverResult.durationMs,
					totalDurationMs: this.now() - started,
					pagination: { paginated: false, pageSize: 0, hasMore: false, nextCursor: null },
					truncated: { byRows: false, byBytes: false },
				};
			});
		} catch (error) {
			throw this.toExecutionError(input.connId, input.caller, error);
		}
	}

	private toExecutionError(connId: string, caller: DbCaller, error: unknown): QueryExecutionError {
		if (error instanceof QueryExecutionError) {
			return error;
		}
		const normalized = normalizeQueryError(error);
		log.debug("query failed", { connId, caller, code: normalized.code, error });
		return new QueryExecutionError(normalized, { cause: error });
	}

	/** Run a prepared (sql, params) under the per-query timeout + cancellation + teardown. */
	private runUnderDeadline(args: {
		connId: string;
		sql: string;
		caller: DbCaller;
		params: ReadonlyArray<unknown> | undefined;
		timeoutMs: number;
		signal: AbortSignal | undefined;
	}): Promise<QueryResult> {
		return runWithDeadline(
			() =>
				this.deps.service.runQuery({
					connId: args.connId,
					sql: args.sql,
					caller: args.caller,
					params: args.params,
					// Push the deadline down to the DB so it cancels a runaway query server-side, not
					// just in-process. (0 disables; the driver ignores it for engines that can't honor it.)
					timeoutMs: args.timeoutMs,
				}),
			{
				timeoutMs: args.timeoutMs,
				signal: args.signal,
				onAbandon: (reason) => {
					// Drop the pooled driver so the runaway query's sockets are torn down and
					// the runtime regains control immediately.
					log.warn("abandoning query; tearing down connection", { connId: args.connId, reason });
					void this.deps.service.invalidate(args.connId);
				},
			},
		);
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

		const driverResult = await this.runUnderDeadline({
			connId: input.connId,
			sql: bounded.sql,
			caller: input.caller,
			params: input.params,
			timeoutMs: limits.timeoutMs,
			signal: input.signal,
		});

		return this.shapeResult({ input, started, classification, pageSize, bounded, driverResult, limits });
	}

	private async runBrowse(input: BrowseTableInput, started: number): Promise<ExecuteQueryResult> {
		const limits = { ...this.limits, ...input.limits };
		const record = await this.deps.loadConnection(input.connId);
		if (!record) {
			throw new DbConnectionError(`unknown connection: "${input.connId}"`);
		}
		const pageSize = clampPageSize(input.page?.pageSize ?? limits.defaultPageSize, limits.maxRows);
		const detail = await this.deps.service.describeTable({
			connId: input.connId,
			caller: input.caller,
			schema: input.schema,
			table: input.table,
		});
		const key = selectKeysetKey(detail);
		const cursor = decodeBrowseCursor(input.page?.cursor);

		let sql: string;
		let params: unknown[];
		let strategy: { mode: "keyset"; keyColumns: string[] } | { mode: "offset"; offset: number };
		if (key) {
			// A cursor minted for the OFFSET fallback can't resume a keyset scan — reject it loudly
			// rather than silently restarting from the top.
			if (cursor && cursor.mode !== "keyset") {
				throw new InvalidCursorError();
			}
			const built = buildKeysetQuery({
				engine: record.engine,
				schema: input.schema,
				table: input.table,
				keyColumns: key.columns,
				cursorValues: cursor?.mode === "keyset" ? cursor.values : null,
				pageSize,
			});
			sql = built.sql;
			params = built.params;
			strategy = { mode: "keyset", keyColumns: key.columns };
		} else {
			if (cursor && cursor.mode !== "offset") {
				throw new InvalidCursorError();
			}
			const offset = cursor?.mode === "offset" ? cursor.offset : 0;
			const ref = quoteQualifiedTable(record.engine, input.schema, input.table);
			// Deterministic order so OFFSET paging is stable even without a key (best effort).
			const firstColumn = detail.columns[0]?.name;
			const orderBy = firstColumn ? ` ORDER BY ${quoteIdentifier(record.engine, firstColumn)} ASC` : "";
			sql = `SELECT * FROM ${ref}${orderBy} LIMIT ${pageSize + 1} OFFSET ${offset}`;
			params = [];
			strategy = { mode: "offset", offset };
		}

		const driverResult = await this.runUnderDeadline({
			connId: input.connId,
			sql,
			caller: input.caller,
			params,
			timeoutMs: limits.timeoutMs,
			signal: input.signal,
		});

		const probeHasMore = driverResult.rows.length > pageSize;
		let rows = probeHasMore ? driverResult.rows.slice(0, pageSize) : driverResult.rows;
		const capped = capRowsByBytes(rows, limits.maxBytes);
		rows = capped.rows;
		const truncatedByBytes = capped.truncated;
		const hasMore = probeHasMore || truncatedByBytes;
		let nextCursor: string | null = null;
		const last = rows[rows.length - 1];
		if (hasMore && last) {
			nextCursor =
				strategy.mode === "keyset"
					? encodeKeysetCursor(keyValuesOf(last, strategy.keyColumns))
					: encodeBrowseCursor({ mode: "offset", offset: strategy.offset + rows.length });
		}

		return {
			columns: driverResult.fields,
			rows,
			rowCount: rows.length,
			affectedRows: null,
			classification: "read",
			readOnly: true,
			durationMs: driverResult.durationMs,
			totalDurationMs: this.now() - started,
			pagination: { paginated: true, pageSize, hasMore, nextCursor },
			truncated: { byRows: false, byBytes: truncatedByBytes },
		};
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
