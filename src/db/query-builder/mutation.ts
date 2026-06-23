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

/** Render `col = ?` predicates joined by AND, pushing each value onto `params`. */
function renderKey(
	engine: DatabaseEngine,
	key: ReadonlyArray<ColumnValue>,
	nextPlaceholder: () => string,
	params: Array<string | null>,
): string {
	return key
		.map((k) => {
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
