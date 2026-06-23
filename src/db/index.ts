// Importing the adapter modules registers their engine factories as a side effect.
import "./driver/postgres-driver";
import "./driver/mysql-driver";
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
