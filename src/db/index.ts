// Importing the adapter modules registers their engine factories as a side effect.
// Postgres/MySQL run on Bun's native SQL client; SQLite stays on bun:sqlite.
import "./driver/bun-sql/register";
import "./driver/sqlite-driver";

export {
	DatabaseService,
	type DbServiceDeps,
	type DescribeTableInput,
	type IntrospectInput,
	type ListTablesInput,
	type RunQueryInput,
} from "./db-service";
export type { DatabaseDriver } from "./driver/driver";
export { createDriver, registerDriver } from "./driver/driver-registry";
export * from "./errors";
export { getIntrospectionCache, IntrospectionCache } from "./introspection/introspection-cache";
export { type AccessPolicyInput, assertOperationAllowed, type ResolvedOperation } from "./policy/access-policy";
export { classifySql } from "./policy/sql-classifier";
export { PoolManager, type PoolManagerOptions } from "./pool/pool-manager";
export {
	type ConnectionRecord,
	connectionRecordSchema,
	type DbCredential,
	type DbCredentialsData,
	databaseEngineSchema,
	dbCredentialsDataSchema,
} from "./registry/connection-record";
export {
	normalizeConnId,
	readConnections,
	readCredentials,
	resolveConnectionConfig,
	writeConnections,
	writeCredentials,
} from "./registry/connection-store";
export * from "./types";
export {
	type BuildBrowseQueryInput,
	type BuildDeleteRowInput,
	type BuildInsertRowInput,
	type BuildUpdateRowInput,
	type BuiltQuery,
	buildBrowseQuery,
	buildDeleteRow,
	buildInsertRow,
	buildUpdateRow,
	type ColumnValue,
	type DbFilter,
	type DbFilterOp,
	type DbSort,
} from "./query-builder";
export {
	type ExecuteQueryInput,
	type ExecuteQueryPagination,
	type ExecuteQueryResult,
	type NormalizedQueryError,
	type QueryErrorCode,
	QueryExecutionError,
	QueryExecutor,
	type QueryExecutorDeps,
} from "./execution";
export { formatDbCell, formatDbRow } from "./result-format";
