/** Database engines the core supports. Extend this union + the driver-registry to add more. */
export type DatabaseEngine = "postgres" | "mysql" | "sqlite" | "redis";

/** The upper entry on whose behalf an operation runs. Drives policy strictness. */
export type DbCaller = "agent" | "human" | "cli";

/** Read/write classification of a single SQL statement. `unknown` fails closed (treated as write). */
export type SqlClassification = "read" | "write" | "ddl" | "unknown";

/** Non-secret transport security metadata (key/cert material is a secret, kept separate). */
export interface DbSslConfig {
	mode: "disable" | "require" | "verify-ca" | "verify-full";
	caPath?: string;
}

/**
 * A fully-resolved connection config (committed metadata + machine-home secret merged
 * in memory at connect time). `password`/`sslKeyPem`/`sslCertPem` are NEVER persisted
 * in committed data.
 */
export interface ConnectionConfig {
	engine: DatabaseEngine;
	host?: string;
	port?: number;
	database?: string;
	user?: string;
	/** SQLite database file path. */
	filePath?: string;
	ssl?: DbSslConfig;
	password?: string;
	sslKeyPem?: string;
	sslCertPem?: string;
}

/** One statement to execute. `readOnly` is decided by the policy layer, not the driver. */
export interface QueryRequest {
	sql: string;
	params?: ReadonlyArray<unknown>;
	readOnly: boolean;
	/**
	 * Server-side execution deadline in ms. When set (> 0), a read-only statement is run under
	 * an engine-native statement timeout (Postgres `statement_timeout`, MySQL `max_execution_time`)
	 * so the DATABASE cancels a runaway query at the deadline — not just the in-process timeout,
	 * which returns control to the runtime but leaves the query consuming server resources. SQLite
	 * (synchronous) cannot honor it. Absent / ≤ 0 disables it.
	 */
	timeoutMs?: number;
}

export interface FieldInfo {
	name: string;
	dataTypeId?: number;
	dataType?: string;
}

export interface QueryResult {
	rows: Array<Record<string, unknown>>;
	fields: FieldInfo[];
	rowCount: number;
	durationMs: number;
	/**
	 * Engine-native continuation token (Redis SCAN cursor). "0" means the scan is complete.
	 * Present only for engines that page natively; SQL drivers leave it undefined and the
	 * executor falls back to the +1-probe-row heuristic.
	 */
	scanCursor?: string;
}

export interface ColumnInfo {
	name: string;
	dataType: string;
	nullable: boolean;
	isPrimaryKey: boolean;
	defaultValue: string | null;
}

export interface TableInfo {
	schema: string;
	name: string;
	kind: "table" | "view";
	columns: ColumnInfo[];
}

export interface SchemaIntrospection {
	engine: DatabaseEngine;
	tables: TableInfo[];
}

// ---------------------------------------------------------------------------
// Lazy, hierarchical introspection (schemas → tables → table detail).
//
// The eager `SchemaIntrospection` above pulls every column of every table in
// one shot. The types below back the lazy backend: each level is fetched only
// when the consumer expands into it, so a huge database is never materialized
// wholesale. Shapes are deliberately identical across engines — a Postgres
// schema, a MySQL database, and a SQLite attached database all surface as a
// `SchemaSummary`; `TableSummary.schema` / `TableDetail.schema` reference that
// same name.
// ---------------------------------------------------------------------------

/**
 * A top-level namespace within one connection: a Postgres schema, a MySQL
 * database, or a SQLite attached database (usually just `main`). System
 * catalogs are filtered out by the drivers.
 */
export interface SchemaSummary {
	name: string;
}

/** A table or view within a schema — name + kind only, no columns (lazy). */
export interface TableSummary {
	schema: string;
	name: string;
	kind: "table" | "view";
}

/** One index on a table, with its ordered column list. */
export interface IndexInfo {
	name: string;
	/** Indexed columns in index order (composite indexes keep their ordering). */
	columns: string[];
	isUnique: boolean;
	/** True when this index backs the table's PRIMARY KEY constraint. */
	isPrimary: boolean;
}

/** One foreign-key constraint: local columns → referenced table columns. */
export interface ForeignKeyInfo {
	/** Constraint name, or null when the engine does not expose one. */
	name: string | null;
	/** Local columns, ordered to line up positionally with `referencedColumns`. */
	columns: string[];
	referencedSchema: string;
	referencedTable: string;
	referencedColumns: string[];
}

/**
 * Full detail of a single table or view, fetched only when it is expanded.
 * `columns[].isPrimaryKey` is the authoritative per-column primary-key flag
 * (the human editor and safe UPDATE/DELETE WHERE generation depend on it);
 * the primary key is additionally surfaced as an entry in `indexes` with
 * `isPrimary: true` (except a SQLite `INTEGER PRIMARY KEY` rowid alias, which
 * has no backing index — there `isPrimaryKey` on the column is the only signal).
 */
export interface TableDetail {
	schema: string;
	name: string;
	kind: "table" | "view";
	columns: ColumnInfo[];
	indexes: IndexInfo[];
	foreignKeys: ForeignKeyInfo[];
}

export interface TestConnectionResult {
	ok: boolean;
	latencyMs: number;
	serverVersion: string | null;
}
