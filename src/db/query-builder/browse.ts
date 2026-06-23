import type { DatabaseEngine } from "../types";
import { type DbFilter, buildWhereClause } from "./filters";
import { quoteIdentifier, quoteQualifiedTable } from "./identifier";

export interface DbSort {
	column: string;
	direction: "asc" | "desc";
}

export interface BuiltQuery {
	sql: string;
	params: Array<string | null>;
}

export interface BuildBrowseQueryInput {
	engine: DatabaseEngine;
	schema: string;
	table: string;
	filters?: ReadonlyArray<DbFilter>;
	sort?: ReadonlyArray<DbSort>;
}

/**
 * Build the unbounded `SELECT * FROM <table> [WHERE …] [ORDER BY …]` for browsing a table.
 * Deliberately omits any LIMIT/OFFSET — the {@link QueryExecutor} wraps this with the
 * server-side LIMIT bound and opaque-cursor pagination, so the row cap can never be bypassed
 * by the data browser.
 */
export function buildBrowseQuery(input: BuildBrowseQueryInput): BuiltQuery {
	const { engine } = input;
	const parts = [`SELECT * FROM ${quoteQualifiedTable(engine, input.schema, input.table)}`];

	const where = buildWhereClause(engine, input.filters ?? []);
	if (where.sql) {
		parts.push(`WHERE ${where.sql}`);
	}

	if (input.sort && input.sort.length > 0) {
		const orderBy = input.sort
			.map((s) => `${quoteIdentifier(engine, s.column)} ${s.direction === "desc" ? "DESC" : "ASC"}`)
			.join(", ");
		parts.push(`ORDER BY ${orderBy}`);
	}

	return { sql: parts.join(" "), params: where.params };
}
