// The query-execution backend: a pure-backend capability layered on top of the DB core
// (driver interface + pool + policy chokepoint). Shared by the MCP / CLI / UI heads; this
// module adds no UI/MCP/CLI surface itself.

export {
	type BoundedQuery,
	type BuildBoundedQueryInput,
	buildBoundedQuery,
	type CappedRows,
	capRowsByBytes,
	decodeOffsetCursor,
	encodeOffsetCursor,
	type FinalizedPage,
	type FinalizePageInput,
	finalizePage,
	type PageRequest,
} from "./query-bounds";
export { type AbandonReason, type DeadlineOptions, runWithDeadline } from "./query-deadline";
export {
	type NormalizedQueryError,
	normalizeQueryError,
	type QueryErrorCode,
	QueryExecutionError,
} from "./query-error-normalizer";
export {
	type BrowseTableInput,
	DEFAULT_QUERY_EXECUTION_LIMITS,
	type ExecuteQueryInput,
	type ExecuteQueryPagination,
	type ExecuteQueryResult,
	type QueryExecutionLimits,
	QueryExecutor,
	type QueryExecutorDeps,
} from "./query-executor";
export {
	type BrowseCursor,
	buildKeysetQuery,
	type BuildKeysetQueryInput,
	decodeBrowseCursor,
	decodeKeysetCursor,
	encodeBrowseCursor,
	encodeKeysetCursor,
	type KeysetQuery,
	keyValuesOf,
	quoteIdentifier,
	quoteQualifiedTable,
	selectKeysetKey,
} from "./query-keyset";
export {
	createQueryConcurrencyLimiter,
	getQueryConcurrencyLimiter,
	QUERY_CONCURRENCY_ENV,
	QUERY_PER_CONNECTION_CONCURRENCY_ENV,
	type QueryConcurrencyLimiter,
	type QueryConcurrencyOptions,
	resolveConcurrency,
} from "./query-limiter";
