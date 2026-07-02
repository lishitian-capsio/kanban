import type { DatabaseEngine } from "../types";
import type { BuiltQuery } from "./browse";
import { createPlaceholderFactory, quoteIdentifier, quoteQualifiedTable } from "./identifier";

/** A single `column = value` pairing used for SET assignments and WHERE keys. */
export interface ColumnValue {
	column: string;
	value: string | null;
}

interface MutationBase {
	engine: DatabaseEngine;
	schema: string;
	table: string;
}

export interface BuildUpdateRowInput extends MutationBase {
	assignments: ReadonlyArray<ColumnValue>;
	/** Row-identifying key (the introspected primary key). Must be non-empty. */
	where: ReadonlyArray<ColumnValue>;
}

export interface BuildInsertRowInput extends MutationBase {
	values: ReadonlyArray<ColumnValue>;
}

export interface BuildDeleteRowInput extends MutationBase {
	/** Row-identifying key (the introspected primary key). Must be non-empty. */
	where: ReadonlyArray<ColumnValue>;
}

/** The three row-write kinds the human editor can emit. */
export type RowWriteOp = "update" | "insert" | "delete";

/**
 * A single, op-tagged row write. The one input shape the editor's preview AND execute paths share,
 * so the previewed SQL is guaranteed byte-identical to what runs. Field requirements match the
 * underlying builder per op (assignments+where for update, values for insert, where for delete).
 */
export interface BuildRowWriteInput extends MutationBase {
	op: RowWriteOp;
	assignments?: ReadonlyArray<ColumnValue>;
	values?: ReadonlyArray<ColumnValue>;
	where?: ReadonlyArray<ColumnValue>;
}

/**
 * Render `col = ?` predicates joined by AND, pushing each value onto `params`. A NULL key value
 * renders as `col IS NULL` (and consumes no placeholder) — `col = NULL` is never true, so this is
 * required for full-row matching on nullable columns (the no-primary-key edit path). Primary-key
 * keys are non-null, so their SQL is unchanged.
 */
function renderKey(
	engine: DatabaseEngine,
	key: ReadonlyArray<ColumnValue>,
	nextPlaceholder: () => string,
	params: Array<string | null>,
): string {
	return key
		.map((k) => {
			if (k.value === null) {
				return `${quoteIdentifier(engine, k.column)} IS NULL`;
			}
			params.push(k.value);
			return `${quoteIdentifier(engine, k.column)} = ${nextPlaceholder()}`;
		})
		.join(" AND ");
}

/**
 * Build a single-row `UPDATE`. The WHERE key MUST be non-empty (the caller supplies the table's
 * primary key) so the statement can never become an unbounded mass update. Params are ordered
 * assignments-first then WHERE, matching the placeholder mint order.
 */
export function buildUpdateRow(input: BuildUpdateRowInput): BuiltQuery {
	if (input.assignments.length === 0) {
		throw new Error("buildUpdateRow: no columns to update");
	}
	if (input.where.length === 0) {
		throw new Error("buildUpdateRow: empty WHERE key; refusing an unbounded update");
	}
	const nextPlaceholder = createPlaceholderFactory(input.engine);
	const params: Array<string | null> = [];
	const setClause = input.assignments
		.map((a) => {
			params.push(a.value);
			return `${quoteIdentifier(input.engine, a.column)} = ${nextPlaceholder()}`;
		})
		.join(", ");
	const whereClause = renderKey(input.engine, input.where, nextPlaceholder, params);
	const target = quoteQualifiedTable(input.engine, input.schema, input.table);
	return { sql: `UPDATE ${target} SET ${setClause} WHERE ${whereClause}`, params };
}

/** Build a single-row `INSERT`. At least one column value is required. */
export function buildInsertRow(input: BuildInsertRowInput): BuiltQuery {
	if (input.values.length === 0) {
		throw new Error("buildInsertRow: no values to insert");
	}
	const nextPlaceholder = createPlaceholderFactory(input.engine);
	const params: Array<string | null> = [];
	const columns = input.values.map((v) => quoteIdentifier(input.engine, v.column)).join(", ");
	const placeholders = input.values
		.map((v) => {
			params.push(v.value);
			return nextPlaceholder();
		})
		.join(", ");
	const target = quoteQualifiedTable(input.engine, input.schema, input.table);
	return { sql: `INSERT INTO ${target} (${columns}) VALUES (${placeholders})`, params };
}

/**
 * Build a single-row `DELETE`. The WHERE key MUST be non-empty (the caller supplies the table's
 * primary key) so the statement can never become an unbounded mass delete.
 */
export function buildDeleteRow(input: BuildDeleteRowInput): BuiltQuery {
	if (input.where.length === 0) {
		throw new Error("buildDeleteRow: empty WHERE key; refusing an unbounded delete");
	}
	const nextPlaceholder = createPlaceholderFactory(input.engine);
	const params: Array<string | null> = [];
	const whereClause = renderKey(input.engine, input.where, nextPlaceholder, params);
	const target = quoteQualifiedTable(input.engine, input.schema, input.table);
	return { sql: `DELETE FROM ${target} WHERE ${whereClause}`, params };
}

/**
 * Dispatch a single op-tagged row write to the matching builder. Used by both the SQL preview and
 * the execute path so they can never diverge. The per-op builders enforce their own invariants
 * (non-empty assignments / values / WHERE), so a malformed request still fails closed here.
 */
export function buildRowWrite(input: BuildRowWriteInput): BuiltQuery {
	const base = { engine: input.engine, schema: input.schema, table: input.table };
	switch (input.op) {
		case "update":
			return buildUpdateRow({ ...base, assignments: input.assignments ?? [], where: input.where ?? [] });
		case "insert":
			return buildInsertRow({ ...base, values: input.values ?? [] });
		case "delete":
			return buildDeleteRow({ ...base, where: input.where ?? [] });
	}
}
