/** Database engines the core supports. Extend this union + the driver-registry to add more. */
export type DatabaseEngine = "postgres" | "mysql" | "sqlite";

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

export interface TestConnectionResult {
	ok: boolean;
	latencyMs: number;
	serverVersion: string | null;
}
