import { readFileSync } from "node:fs";

import { createPool, type PoolOptions } from "mysql2/promise";

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

const log = createLogger("db:mysql-driver");

type Row = Record<string, unknown>;
interface FieldPacketLike {
	name: string;
	columnType?: number;
}
type QueryReturn = [unknown, FieldPacketLike[] | undefined];

interface MysqlConnLike {
	query(sql: string, values?: unknown[]): Promise<QueryReturn>;
	release(): void;
}
/** Minimal `mysql2` pool surface used by this driver — lets tests inject a fake. */
export interface MysqlPoolLike {
	getConnection(): Promise<MysqlConnLike>;
	query(sql: string, values?: unknown[]): Promise<QueryReturn>;
	end(): Promise<void>;
}

export type MysqlPoolFactory = (config: PoolOptions) => MysqlPoolLike;

function toPoolOptions(config: ConnectionConfig): PoolOptions {
	let ssl: PoolOptions["ssl"];
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

function isRowArray(value: unknown): value is Row[] {
	return Array.isArray(value) && value.every((r) => typeof r === "object");
}

export class MysqlDriver implements DatabaseDriver {
	readonly engine = "mysql" as const;
	private pool: MysqlPoolLike | null = null;

	constructor(
		private readonly config: ConnectionConfig,
		private readonly poolFactory: MysqlPoolFactory = (cfg) => createPool(cfg) as unknown as MysqlPoolLike,
	) {}

	async connect(): Promise<void> {
		if (this.pool) {
			return;
		}
		this.pool = this.poolFactory(toPoolOptions(this.config));
	}

	async disconnect(): Promise<void> {
		await this.pool?.end();
		this.pool = null;
	}

	private require(): MysqlPoolLike {
		if (!this.pool) {
			throw new DbConnectionError("mysql driver is not connected");
		}
		return this.pool;
	}

	async testConnection(): Promise<TestConnectionResult> {
		const started = performance.now();
		const [rows] = await this.require().query("SELECT VERSION() AS v");
		const version = isRowArray(rows) ? ((rows[0]?.v as string | undefined) ?? null) : null;
		return { ok: true, latencyMs: performance.now() - started, serverVersion: version };
	}

	async query(request: QueryRequest): Promise<QueryResult> {
		const pool = this.require();
		const started = performance.now();
		const params = request.params ? [...request.params] : undefined;
		if (request.readOnly) {
			const conn = await pool.getConnection();
			try {
				await conn.query("START TRANSACTION READ ONLY");
				const [rows, fields] = await conn.query(request.sql, params);
				await conn.query("COMMIT");
				return this.toResult(rows, fields, started);
			} catch (error) {
				try {
					await conn.query("ROLLBACK");
				} catch {
					// best-effort rollback
				}
				throw new DbQueryError(`mysql query failed: ${String(error)}`, error);
			} finally {
				conn.release();
			}
		}
		try {
			const [rows, fields] = await pool.query(request.sql, params);
			return this.toResult(rows, fields, started);
		} catch (error) {
			throw new DbQueryError(`mysql query failed: ${String(error)}`, error);
		}
	}

	private toResult(rows: unknown, fields: FieldPacketLike[] | undefined, started: number): QueryResult {
		if (isRowArray(rows)) {
			return {
				rows,
				fields: (fields ?? []).map((f) => ({ name: f.name, dataTypeId: f.columnType })),
				rowCount: rows.length,
				durationMs: performance.now() - started,
			};
		}
		// Write result (ResultSetHeader): no rows; report affectedRows.
		const affected = (rows as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
		return { rows: [], fields: [], rowCount: affected, durationMs: performance.now() - started };
	}

	async introspect(): Promise<SchemaIntrospection> {
		const pool = this.require();
		const sql = `
			SELECT c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type,
			       c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
			       c.COLUMN_DEFAULT AS column_default, (c.COLUMN_KEY = 'PRI') AS is_primary_key
			FROM information_schema.COLUMNS c
			JOIN information_schema.TABLES t
			  ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
			WHERE c.TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
			ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`;
		const [rows] = await pool.query(sql);
		const tables = isRowArray(rows) ? groupColumnsIntoTables(rows) : [];
		log.debug("mysql introspect complete", { tableCount: tables.length });
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
	is_primary_key: number | boolean;
}

function groupColumnsIntoTables(rows: Row[]): TableInfo[] {
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
			isPrimaryKey: raw.is_primary_key === 1 || raw.is_primary_key === true,
			defaultValue: raw.column_default,
		};
		table.columns.push(column);
	}
	return [...byTable.values()];
}

registerDriver("mysql", (config) => new MysqlDriver(config));
