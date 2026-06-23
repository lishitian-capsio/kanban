// Pure, engine-aware SQL builders for the data browser / inline editor. The frontend never
// writes SQL — it sends structured browse/edit intents and these builders produce the
// parameterized SQL that runs through the QueryExecutor (server-side LIMIT bound + policy
// chokepoint). Identifiers are quoted here; values ALWAYS travel as bound params.

export { type BuildBrowseQueryInput, type BuiltQuery, buildBrowseQuery, type DbSort } from "./browse";
export { type DbFilter, type DbFilterOp, buildWhereClause, type WhereClause } from "./filters";
export { createPlaceholderFactory, quoteIdentifier, quoteQualifiedTable } from "./identifier";
export {
	type BuildDeleteRowInput,
	type BuildInsertRowInput,
	type BuildUpdateRowInput,
	buildDeleteRow,
	buildInsertRow,
	buildUpdateRow,
	type ColumnValue,
} from "./mutation";
