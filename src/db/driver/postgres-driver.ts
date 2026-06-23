import { readFileSync } from "node:fs";

import { Pool, type PoolConfig } from "pg";

import { createLogger } from "../../logging";
import { DbConnectionError, DbQueryError } from "../errors";
import type {
	ColumnInfo,
	ConnectionConfig,
	QueryRequest,
	QueryResult,
	SchemaIntrospection,
	TableInfo,
	TestConnectionResult,
} from "../types";
import type { DatabaseDriver } from "./driver";
import { registerDriver } from "./driver-registry";

const log = createLogger("db:postgres-driver");

interface PgRow {
	[key: string]: unknown;
}
interface PgResultLike {
	rows: PgRow[];
	fields: Array<{ name: string; dataTypeID?: number }>;
	rowCount: number | null;
}
interface PgClientLike {
	query(text: string, values?: unknown[]): Promise<PgResultLike>;
	release(): void;
}
/** The minimal `pg.Pool` surface this driver uses — lets tests inject a fake. */
export interface PgPoolLike {
	connect(): Promise<PgClientLike>;
	query(text: string, values?: unknown[]): Promise<PgResultLike>;
	end(): Promise<void>;
}

export type PgPoolFactory = (config: PoolConfig) => PgPoolLike;

function toPoolConfig(config: ConnectionConfig): PoolConfig {
	let ssl: PoolConfig["ssl"];
	if (config.ssl && config.ssl.mode !== "disable") {
		const sslOpts: { rejectUnauthorized: boolean; ca?: string; key?: string; cert?: string } = {
			rejectUnauthorized: config.ssl.mode === "verify-full" || config.ssl.mode === "verify-ca",
		};
		if (config.ssl.caPath) {
			sslOpts.ca = readFileSync(config.ssl.caPath, "utf8");
		}
		if (config.sslKeyPem) {
			sslOpts.key = config.sslKeyPem;
		}
		if (config.sslCertPem) {
			sslOpts.cert = config.sslCertPem;
		}
		ssl = sslOpts;
	}
	return {
		host: config.host,
		port: config.port,
		database: config.database,
		user: config.user,
		password: config.password,
		ssl,
	};
}

export class PostgresDriver implements DatabaseDriver {
	readonly engine = "postgres" as const;
	private pool: PgPoolLike | null = null;

	constructor(
		private readonly config: ConnectionConfig,
		private readonly poolFactory: PgPoolFactory = (cfg) => new Pool(cfg) as unknown as PgPoolLike,
	) {}

	async connect(): Promise<void> {
		if (this.pool) {
			return;
		}
		this.pool = this.poolFactory(toPoolConfig(this.config));
	}

	async disconnect(): Promise<void> {
		await this.pool?.end();
		this.pool = null;
	}

	private require(): PgPoolLike {
		if (!this.pool) {
			throw new DbConnectionError("postgres driver is not connected");
		}
		return this.pool;
	}

	async testConnection(): Promise<TestConnectionResult> {
		const started = performance.now();
		const result = await this.require().query("SELECT version() AS v");
		const version = (result.rows[0]?.v as string | undefined) ?? null;
		return { ok: true, latencyMs: performance.now() - started, serverVersion: version };
	}

	async query(request: QueryRequest): Promise<QueryResult> {
		const pool = this.require();
		const started = performance.now();
		const params = request.params ? [...request.params] : undefined;
		if (request.readOnly) {
			const client = await pool.connect();
			try {
				await client.query("BEGIN TRANSACTION READ ONLY");
				const result = await client.query(request.sql, params);
				await client.query("COMMIT");
				return this.toResult(result, started);
			} catch (error) {
				try {
					await client.query("ROLLBACK");
				} catch {
					// best-effort rollback
				}
				throw new DbQueryError(`postgres query failed: ${String(error)}`, error);
			} finally {
				client.release();
			}
		}
		try {
			const result = await pool.query(request.sql, params);
			return this.toResult(result, started);
		} catch (error) {
			throw new DbQueryError(`postgres query failed: ${String(error)}`, error);
		}
	}

	private toResult(result: PgResultLike, started: number): QueryResult {
		return {
			rows: result.rows,
			fields: result.fields.map((f) => ({ name: f.name, dataTypeId: f.dataTypeID })),
			rowCount: result.rowCount ?? result.rows.length,
			durationMs: performance.now() - started,
		};
	}

	async introspect(): Promise<SchemaIntrospection> {
		const pool = this.require();
		const sql = `
			SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type,
			       c.is_nullable, c.column_default,
			       (pk.column_name IS NOT NULL) AS is_primary_key
			FROM information_schema.columns c
			JOIN information_schema.tables t
			  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
			LEFT JOIN (
			  SELECT kcu.table_schema, kcu.table_name, kcu.column_name
			  FROM information_schema.table_constraints tc
			  JOIN information_schema.key_column_usage kcu
			    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
			  WHERE tc.constraint_type = 'PRIMARY KEY'
			) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name
			WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
			ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
		const result = await pool.query(sql);
		const tables = groupColumnsIntoTables(result.rows);
		log.debug("postgres introspect complete", { tableCount: tables.length });
		return { engine: this.engine, tables };
	}
}

interface FlatColumnRow {
	table_schema: string;
	table_name: string;
	table_type: string;
	column_name: string;
	data_type: string;
	is_nullable: string;
	column_default: string | null;
	is_primary_key: boolean;
}

/** Fold an ordered flat column result into TableInfo[] (shared shape across SQL engines). */
function groupColumnsIntoTables(rows: PgRow[]): TableInfo[] {
	const byTable = new Map<string, TableInfo>();
	for (const raw of rows as unknown as FlatColumnRow[]) {
		const key = `${raw.table_schema}.${raw.table_name}`;
		let table = byTable.get(key);
		if (!table) {
			table = {
				schema: raw.table_schema,
				name: raw.table_name,
				kind: raw.table_type === "VIEW" ? "view" : "table",
				columns: [],
			};
			byTable.set(key, table);
		}
		const column: ColumnInfo = {
			name: raw.column_name,
			dataType: raw.data_type,
			nullable: raw.is_nullable === "YES",
			isPrimaryKey: raw.is_primary_key === true,
			defaultValue: raw.column_default,
		};
		table.columns.push(column);
	}
	return [...byTable.values()];
}

registerDriver("postgres", (config) => new PostgresDriver(config));
