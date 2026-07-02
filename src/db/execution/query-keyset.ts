import { InvalidCursorError } from "../errors";
import { type DatabaseEngine, engineWireProtocol, type TableDetail } from "../types";

/**
 * Keyset (a.k.a. seek) pagination for large-table browsing.
 *
 * OFFSET pagination is O(offset): the engine scans and discards every row before the page,
 * so deep pages on a million-row table degrade badly (measured: MySQL ~37ms → ~484ms from
 * offset 0 → 900k). Keyset pagination instead resumes from the last row's ordering key —
 * `WHERE (k) > (lastKey) ORDER BY k LIMIT n` — which is index-served and stays flat (~8ms)
 * at any depth. The trade-off is that it needs a deterministic, total ordering key; we use
 * the table's PRIMARY KEY (always present + NOT NULL on a well-formed table). When a table
 * has no usable key the caller falls back to OFFSET.
 *
 * The cursor is the opaque token from the prior page (the last row's key values), kept
 * engine-agnostic and tagged so non-JSON cell types (bigint, Date) round-trip exactly.
 */

const BIGINT_TAG = "__kbig__";
const DATE_TAG = "__kdate__";

interface TaggedBigint {
	[BIGINT_TAG]: string;
}
interface TaggedDate {
	[DATE_TAG]: string;
}

function encodeValue(value: unknown): unknown {
	if (typeof value === "bigint") {
		return { [BIGINT_TAG]: value.toString() } satisfies TaggedBigint;
	}
	if (value instanceof Date) {
		return { [DATE_TAG]: value.toISOString() } satisfies TaggedDate;
	}
	return value;
}

function decodeValue(value: unknown): unknown {
	if (typeof value === "object" && value !== null) {
		if (BIGINT_TAG in value && typeof (value as TaggedBigint)[BIGINT_TAG] === "string") {
			return BigInt((value as TaggedBigint)[BIGINT_TAG]);
		}
		if (DATE_TAG in value && typeof (value as TaggedDate)[DATE_TAG] === "string") {
			return new Date((value as TaggedDate)[DATE_TAG]);
		}
	}
	return value;
}

/**
 * A browse cursor is self-describing so the same opaque token works for both strategies:
 * `keyset` (the last row's ordering-key values) for tables with a primary key, and `offset`
 * (a row offset) for the fallback when a table has none. The entry never has to know which
 * strategy a connection's table uses.
 */
export type BrowseCursor = { mode: "keyset"; values: unknown[] } | { mode: "offset"; offset: number };

/** Encode the ordering-key values of the last row in a page into an opaque keyset token. */
export function encodeKeysetCursor(values: ReadonlyArray<unknown>): string {
	return encodeBrowseCursor({ mode: "keyset", values: [...values] });
}

/** Encode a browse cursor (keyset or offset) into an opaque resume token. */
export function encodeBrowseCursor(cursor: BrowseCursor): string {
	const payload =
		cursor.mode === "keyset"
			? JSON.stringify({ m: "k", k: cursor.values.map(encodeValue) })
			: JSON.stringify({ m: "o", o: cursor.offset });
	return Buffer.from(payload, "utf8").toString("base64url");
}

/** Decode a browse cursor token. Absent ⇒ null; malformed ⇒ throws {@link InvalidCursorError}. */
export function decodeBrowseCursor(cursor: string | null | undefined): BrowseCursor | null {
	if (cursor === null || cursor === undefined || cursor === "") {
		return null;
	}
	try {
		const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (typeof decoded === "object" && decoded !== null && "m" in decoded) {
			const d = decoded as { m: unknown; k?: unknown; o?: unknown };
			if (d.m === "k" && Array.isArray(d.k)) {
				return { mode: "keyset", values: d.k.map(decodeValue) };
			}
			if (d.m === "o" && typeof d.o === "number" && Number.isInteger(d.o) && d.o >= 0) {
				return { mode: "offset", offset: d.o };
			}
		}
	} catch {
		// fall through
	}
	throw new InvalidCursorError();
}

/** Decode a keyset cursor back to its ordered key values (null for the first page). */
export function decodeKeysetCursor(cursor: string | null | undefined): unknown[] | null {
	const decoded = decodeBrowseCursor(cursor);
	if (decoded === null) {
		return null;
	}
	if (decoded.mode !== "keyset") {
		throw new InvalidCursorError();
	}
	return decoded.values;
}

/** Quote a SQL identifier for the engine (Postgres family double-quote, MySQL family backtick). */
export function quoteIdentifier(engine: DatabaseEngine, name: string): string {
	if (engineWireProtocol(engine) === "mysql") {
		return `\`${name.replace(/`/g, "``")}\``;
	}
	return `"${name.replace(/"/g, '""')}"`;
}

/** A schema-qualified, quoted table reference for the engine. */
export function quoteQualifiedTable(engine: DatabaseEngine, schema: string, table: string): string {
	return `${quoteIdentifier(engine, schema)}.${quoteIdentifier(engine, table)}`;
}

/**
 * Pick the ordering key for keyset browsing: the PRIMARY KEY columns (in column order). A PK
 * is NOT NULL and unique, giving a total order that keyset comparison requires. Returns null
 * when the table has no primary key — the caller then falls back to OFFSET pagination.
 */
export function selectKeysetKey(detail: TableDetail): { columns: string[] } | null {
	const pkColumns = detail.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
	if (pkColumns.length > 0) {
		return { columns: pkColumns };
	}
	return null;
}

export interface BuildKeysetQueryInput {
	engine: DatabaseEngine;
	schema: string;
	table: string;
	/** Ordering-key columns (1+); the row-value tuple compared against the cursor. */
	keyColumns: string[];
	/** Decoded cursor values from the prior page, or null for the first page. */
	cursorValues: ReadonlyArray<unknown> | null;
	/** Rows to return per page; the query fetches pageSize + 1 to detect a next page. */
	pageSize: number;
}

export interface KeysetQuery {
	sql: string;
	params: unknown[];
	/** pageSize + 1 (probe row). */
	fetchLimit: number;
}

/**
 * Build the keyset browse statement:
 *   SELECT * FROM <table> [WHERE (k1,…) > (?,…)] ORDER BY k1 ASC, … LIMIT pageSize+1
 * The LIMIT is an inlined validated integer; cursor values are bound as params.
 */
export function buildKeysetQuery(input: BuildKeysetQueryInput): KeysetQuery {
	if (input.keyColumns.length === 0) {
		throw new Error("keyset query requires at least one key column");
	}
	const pageSize = Math.max(1, Math.trunc(input.pageSize));
	const fetchLimit = pageSize + 1;
	const ref = quoteQualifiedTable(input.engine, input.schema, input.table);
	const quotedKeys = input.keyColumns.map((c) => quoteIdentifier(input.engine, c));
	const orderBy = quotedKeys.map((k) => `${k} ASC`).join(", ");

	let where = "";
	const params: unknown[] = [];
	if (input.cursorValues && input.cursorValues.length > 0) {
		if (input.cursorValues.length !== input.keyColumns.length) {
			throw new InvalidCursorError();
		}
		const placeholders = input.keyColumns.map((_, i) => placeholder(input.engine, i + 1));
		if (quotedKeys.length === 1) {
			where = ` WHERE ${quotedKeys[0]} > ${placeholders[0]}`;
		} else {
			where = ` WHERE (${quotedKeys.join(", ")}) > (${placeholders.join(", ")})`;
		}
		params.push(...input.cursorValues);
	}

	const sql = `SELECT * FROM ${ref}${where} ORDER BY ${orderBy} LIMIT ${fetchLimit}`;
	return { sql, params, fetchLimit };
}

/** Positional placeholder for the engine: Postgres family `$n`, MySQL family / SQLite `?`. */
function placeholder(engine: DatabaseEngine, n: number): string {
	return engineWireProtocol(engine) === "postgres" ? `$${n}` : "?";
}

/** Extract the ordering-key values from a returned row, in key-column order. */
export function keyValuesOf(row: Record<string, unknown>, keyColumns: string[]): unknown[] {
	return keyColumns.map((c) => row[c]);
}
