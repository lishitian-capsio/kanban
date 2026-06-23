import { InvalidCursorError } from "../errors";
import type { SqlClassification } from "../types";

/**
 * Server-side result bounding for the query executor.
 *
 * The core driver materializes every row a statement returns, so the ONLY way to keep a
 * large result set out of runtime memory is to bound it at the database. For a read we
 * wrap the caller's statement in a derived-table `LIMIT … OFFSET …` subquery so the engine
 * itself returns at most one page (+1 probe row used to detect a next page). Writes and
 * unparseable statements are never wrapped — they pass through untouched and stay subject
 * to the policy chokepoint.
 *
 * Pagination is exposed as an opaque cursor token (the API the three upper entries page
 * with). v1 encodes a row offset; this is the robust, engine-agnostic default that works
 * over any SELECT. A keyset strategy (preferred when the caller supplies a unique ordered
 * key) can later be slotted behind the same opaque-token API without a contract change.
 */

const SUBQUERY_ALIAS = "_kanban_q";

/** A page request: how many rows to return and where to resume from. */
export interface PageRequest {
	/** Rows to return per page (caller intent; the executor clamps it to the row cap). */
	pageSize: number;
	/** Opaque resume token from a prior page, or null/undefined for the first page. */
	cursor?: string | null;
}

export interface BuildBoundedQueryInput {
	sql: string;
	classification: SqlClassification;
	page: PageRequest;
}

export interface BoundedQuery {
	/** The SQL to hand to the driver (wrapped for reads, unchanged otherwise). */
	sql: string;
	/** Whether a LIMIT subquery was applied. */
	wrapped: boolean;
	/** Rows the wrapped query asks the engine for (pageSize + 1 probe); 0 when not wrapped. */
	fetchLimit: number;
	/** The offset the page starts at; 0 when not wrapped. */
	offset: number;
}

export interface FinalizePageInput {
	pageSize: number;
	offset: number;
	/** Optional byte budget applied to the page's rows after the row-count trim. */
	maxBytes?: number;
}

export interface FinalizedPage<TRow> {
	rows: TRow[];
	hasMore: boolean;
	nextCursor: string | null;
	truncatedByBytes: boolean;
}

export interface CappedRows<TRow> {
	rows: TRow[];
	truncated: boolean;
}

/** Encode a row offset into an opaque cursor token. */
export function encodeOffsetCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

/** Decode an opaque cursor token back to a row offset. Absent ⇒ 0; malformed ⇒ throws. */
export function decodeOffsetCursor(cursor: string | null | undefined): number {
	if (cursor === null || cursor === undefined || cursor === "") {
		return 0;
	}
	try {
		const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (
			typeof decoded === "object" &&
			decoded !== null &&
			"o" in decoded &&
			typeof (decoded as { o: unknown }).o === "number"
		) {
			const offset = (decoded as { o: number }).o;
			if (Number.isInteger(offset) && offset >= 0) {
				return offset;
			}
		}
	} catch {
		// fall through to the error below
	}
	throw new InvalidCursorError();
}

/** Strip a single trailing statement terminator and surrounding whitespace. */
function stripTrailingSemicolon(sql: string): string {
	return sql.trim().replace(/;\s*$/, "").trimEnd();
}

/**
 * Bound a statement for execution. Reads are wrapped in a `LIMIT pageSize+1 OFFSET n`
 * derived-table subquery; everything else passes through unchanged.
 */
export function buildBoundedQuery(input: BuildBoundedQueryInput): BoundedQuery {
	if (input.classification !== "read") {
		return { sql: input.sql, wrapped: false, fetchLimit: 0, offset: 0 };
	}
	const pageSize = Math.max(1, Math.trunc(input.page.pageSize));
	const offset = decodeOffsetCursor(input.page.cursor);
	const fetchLimit = pageSize + 1;
	const inner = stripTrailingSemicolon(input.sql);
	// LIMIT/OFFSET are validated non-negative integers, so inlining them is injection-safe
	// and avoids cross-engine placeholder-numbering differences ($1 vs ? vs ?n).
	const sql = `SELECT * FROM (${inner}) AS ${SUBQUERY_ALIAS} LIMIT ${fetchLimit} OFFSET ${offset}`;
	return { sql, wrapped: true, fetchLimit, offset };
}

/** JSON replacer so bigint cell values (pg int8 / mysql BIGINT) don't throw during sizing. */
function jsonByteSizeReplacer(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Cap a row array to a serialized-byte budget in a single pass (no per-row event churn).
 * At least one row is always returned so an oversized first row can't stall pagination.
 */
export function capRowsByBytes<TRow>(rows: readonly TRow[], maxBytes: number): CappedRows<TRow> {
	const budget = Math.max(0, maxBytes);
	const kept: TRow[] = [];
	let used = 0;
	let truncated = false;
	for (const row of rows) {
		const size = Buffer.byteLength(JSON.stringify(row, jsonByteSizeReplacer) ?? "null", "utf8");
		// Always keep the first row so an oversized row can't stall pagination.
		if (kept.length > 0 && used + size > budget) {
			truncated = true;
			break;
		}
		kept.push(row);
		used += size;
	}
	// A single kept row may itself exceed the budget — that's still a truncation.
	if (!truncated && used > budget) {
		truncated = true;
	}
	return { rows: kept, truncated };
}

/**
 * Turn the rows the driver returned for a bounded read (up to pageSize + 1) into a page:
 * drop the probe row, optionally cap by bytes, report whether more rows exist, and emit the
 * next cursor (which resumes after the rows actually returned, so a byte-trim never skips
 * rows).
 */
export function finalizePage<TRow>(fetchedRows: readonly TRow[], input: FinalizePageInput): FinalizedPage<TRow> {
	const pageSize = Math.max(1, Math.trunc(input.pageSize));
	const probeHasMore = fetchedRows.length > pageSize;
	let rows = probeHasMore ? fetchedRows.slice(0, pageSize) : [...fetchedRows];

	let truncatedByBytes = false;
	if (input.maxBytes !== undefined) {
		const capped = capRowsByBytes(rows, input.maxBytes);
		rows = capped.rows;
		truncatedByBytes = capped.truncated;
	}

	const hasMore = probeHasMore || truncatedByBytes;
	const nextCursor = hasMore ? encodeOffsetCursor(input.offset + rows.length) : null;
	return { rows, hasMore, nextCursor, truncatedByBytes };
}
