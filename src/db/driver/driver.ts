import type {
	ConnectionConfig,
	DatabaseEngine,
	QueryRequest,
	QueryResult,
	SchemaIntrospection,
	TestConnectionResult,
} from "../types";

export type { ConnectionConfig };

/**
 * The engine-agnostic driver contract. Every adapter (Postgres/MySQL/SQLite/…)
 * implements exactly this surface so the pool manager and service treat all engines
 * identically. `query` trusts the `readOnly` flag the policy layer resolved and opens
 * the matching DB-level session mode (defense-in-depth).
 */
export interface DatabaseDriver {
	readonly engine: DatabaseEngine;
	/** Establish the underlying pool/handle. Idempotent — safe to call repeatedly. */
	connect(): Promise<void>;
	/** Tear down the pool/handle and release sockets/file handles. */
	disconnect(): Promise<void>;
	/** Cheap liveness probe (SELECT 1 / PRAGMA). */
	testConnection(): Promise<TestConnectionResult>;
	/** Execute one statement in the resolved session mode. */
	query(request: QueryRequest): Promise<QueryResult>;
	/** Read the catalog, normalized to {@link SchemaIntrospection}. Always read-only. */
	introspect(): Promise<SchemaIntrospection>;
}
