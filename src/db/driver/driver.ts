import type {
	ConnectionConfig,
	DatabaseEngine,
	QueryRequest,
	QueryResult,
	SchemaIntrospection,
	SchemaSummary,
	TableDetail,
	TableSummary,
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
	/**
	 * Lazy introspection — one tree level at a time, so a huge database is never
	 * materialized wholesale. All three are always read-only catalog reads.
	 */
	/** List the top-level namespaces (Postgres schemas / MySQL databases / SQLite attached dbs). */
	listSchemas(): Promise<SchemaSummary[]>;
	/** List the tables and views within one schema (no columns — expand to get them). */
	listTables(schema: string): Promise<TableSummary[]>;
	/** Full detail of one table/view: columns, indexes, and foreign keys. */
	describeTable(schema: string, table: string): Promise<TableDetail>;
	/**
	 * Cheap freshness probe for the metadata cache — must not issue a heavy query.
	 * SQLite returns the db file's mtime+size; remote engines return a constant
	 * (their caching is gated by the in-process mutation generation instead).
	 */
	metadataSignature(): Promise<string>;
}
