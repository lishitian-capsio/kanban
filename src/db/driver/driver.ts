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

/** One row of a Redis keyspace browse: a key plus its type, TTL, and a bounded value preview. */
export interface RedisKeyspaceRow {
	key: string;
	type: string;
	/** Redis TTL in seconds; -1 = no expiry, -2 = missing (raced away). */
	ttl: number;
	/** Bounded, human-readable value preview rendered per type. */
	value: string;
}

export interface BrowseKeyspaceInput {
	/** Logical db name, e.g. "db0". */
	schema: string;
	/** Key prefix (the segment before the first ':'); "" browses the "(root)" no-delimiter keys. */
	prefix: string;
	/** SCAN cursor to resume from; null/undefined starts a fresh scan at "0". */
	cursor: string | null;
	/** Max keys to materialize this page. */
	limit: number;
	/** Per-value preview element/byte budget. */
	valuePreviewLimit: number;
}

export interface BrowseKeyspaceResult {
	rows: RedisKeyspaceRow[];
	/** The SCAN cursor to resume from; "0" when the scan is complete. */
	scanCursor: string;
	durationMs: number;
}

/**
 * Optional driver capability for KV engines that browse a keyspace instead of SQL tables.
 * SQL drivers do not implement it; the executor feature-detects via {@link isKeyspaceBrowser}.
 */
export interface KeyspaceBrowser {
	browseKeyspace(input: BrowseKeyspaceInput): Promise<BrowseKeyspaceResult>;
}

export function isKeyspaceBrowser(driver: DatabaseDriver): driver is DatabaseDriver & KeyspaceBrowser {
	return typeof (driver as Partial<KeyspaceBrowser>).browseKeyspace === "function";
}
