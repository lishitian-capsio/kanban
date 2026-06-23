import type { DatabaseEngine } from "../types";
import { createPlaceholderFactory, quoteIdentifier } from "./identifier";

/** Filter operators the data browser exposes. `is_null`/`is_not_null` take no value. */
export type DbFilterOp =
	| "eq"
	| "ne"
	| "lt"
	| "lte"
	| "gt"
	| "gte"
	| "contains"
	| "starts_with"
	| "ends_with"
	| "is_null"
	| "is_not_null";

export interface DbFilter {
	column: string;
	op: DbFilterOp;
	/** The comparison value. Ignored for `is_null` / `is_not_null`. */
	value?: string | null;
}

const COMPARISON_SQL: Record<Exclude<DbFilterOp, "is_null" | "is_not_null" | "contains" | "starts_with" | "ends_with">, string> = {
	eq: "=",
	ne: "<>",
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">=",
};

/** Wraps a LIKE term so a `contains`/`starts_with`/`ends_with` filter matches as intended. */
function likeTerm(op: "contains" | "starts_with" | "ends_with", value: string): string {
	if (op === "contains") {
		return `%${value}%`;
	}
	if (op === "starts_with") {
		return `${value}%`;
	}
	return `%${value}`;
}

export interface WhereClause {
	/** The ` AND `-joined predicate text WITHOUT a leading `WHERE`, or "" when empty. */
	sql: string;
	params: Array<string | null>;
}

/**
 * Build a parameterized WHERE predicate from a list of filters, minting placeholders via the
 * shared factory so the same statement can interleave WHERE params with others (e.g. UPDATE SET).
 */
export function buildWhereClause(
	engine: DatabaseEngine,
	filters: ReadonlyArray<DbFilter>,
	nextPlaceholder: () => string = createPlaceholderFactory(engine),
): WhereClause {
	const predicates: string[] = [];
	const params: Array<string | null> = [];
	for (const filter of filters) {
		const column = quoteIdentifier(engine, filter.column);
		if (filter.op === "is_null") {
			predicates.push(`${column} IS NULL`);
			continue;
		}
		if (filter.op === "is_not_null") {
			predicates.push(`${column} IS NOT NULL`);
			continue;
		}
		const value = filter.value ?? "";
		if (filter.op === "contains" || filter.op === "starts_with" || filter.op === "ends_with") {
			predicates.push(`${column} LIKE ${nextPlaceholder()}`);
			params.push(likeTerm(filter.op, value));
			continue;
		}
		predicates.push(`${column} ${COMPARISON_SQL[filter.op]} ${nextPlaceholder()}`);
		params.push(value);
	}
	return { sql: predicates.join(" AND "), params };
}
