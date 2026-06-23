// Importing the adapter modules registers their engine factories as a side effect.
import "./driver/postgres-driver";
import "./driver/mysql-driver";
import "./driver/sqlite-driver";

export * from "./types";
export * from "./errors";
export type { DatabaseDriver } from "./driver/driver";
export { createDriver, registerDriver } from "./driver/driver-registry";
export { PoolManager, type PoolManagerOptions } from "./pool/pool-manager";
export { assertOperationAllowed, type AccessPolicyInput, type ResolvedOperation } from "./policy/access-policy";
export { classifySql } from "./policy/sql-classifier";
export {
	type ConnectionRecord,
	type DbCredential,
	type DbCredentialsData,
	connectionRecordSchema,
	dbCredentialsDataSchema,
	databaseEngineSchema,
} from "./registry/connection-record";
export {
	normalizeConnId,
	readConnections,
	writeConnections,
	readCredentials,
	writeCredentials,
	resolveConnectionConfig,
} from "./registry/connection-store";
export {
	DatabaseService,
	type DbServiceDeps,
	type RunQueryInput,
	type IntrospectInput,
} from "./db-service";
