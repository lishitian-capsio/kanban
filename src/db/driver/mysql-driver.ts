import { readFileSync } from "node:fs";

import { createPool, type PoolOptions } from "mysql2/promise";

import { createLogger } from "../../logging";
import { DbConnectionError, DbQueryError } from "../errors";
import type {
	ColumnInfo,
	ConnectionConfig,
	ForeignKeyInfo,
	IndexInfo,
	QueryRequest,
	QueryResult,
	SchemaIntrospection,
	SchemaSummary,
	TableDetail,
	TableInfo,
	TableSummary,
	TestConnectionResult,
} from "../types";
import type { DatabaseDriver } from "./driver";
import { registerDriver } from "./driver-registry";
import { serverTimeoutMs } from "./driver-timeout";

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
			const timeoutMs = serverTimeoutMs(request.timeoutMs);
			try {
				await conn.query("START TRANSACTION READ ONLY");
				// Server-side deadline: MySQL aborts the read-only SELECT itself at max_execution_time.
				if (timeoutMs > 0) {
					await conn.query(`SET max_execution_time = ${timeoutMs}`);
				}
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
				// Reset before returning the connection to the pool so the limit never leaks.
				if (timeoutMs > 0) {
					try {
						await conn.query("SET max_execution_time = 0");
					} catch {
						// best-effort reset
					}
				}
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

	async listSchemas(): Promise<SchemaSummary[]> {
		const sql = `
			SELECT SCHEMA_NAME AS schema_name
			FROM information_schema.SCHEMATA
			WHERE SCHEMA_NAME NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
			ORDER BY SCHEMA_NAME`;
		const [rows] = await this.require().query(sql);
		if (!isRowArray(rows)) {
			return [];
		}
		return (rows as Array<{ schema_name: string }>).map((r) => ({ name: r.schema_name }));
	}

	async listTables(schema: string): Promise<TableSummary[]> {
		const sql = `
			SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type
			FROM information_schema.TABLES
			WHERE TABLE_SCHEMA = ?
			ORDER BY TABLE_NAME`;
		const [rows] = await this.require().query(sql, [schema]);
		if (!isRowArray(rows)) {
			return [];
		}
		return (rows as Array<{ table_name: string; table_type: string }>).map((r) => ({
			schema,
			name: r.table_name,
			kind: r.table_type === "VIEW" ? "view" : "table",
		}));
	}

	async describeTable(schema: string, table: string): Promise<TableDetail> {
		const pool = this.require();
		const columnsSql = `
			SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable,
			       COLUMN_DEFAULT AS column_default, (COLUMN_KEY = 'PRI') AS is_primary_key
			FROM information_schema.COLUMNS
			WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
			ORDER BY ORDINAL_POSITION`;
		const indexesSql = `
			SELECT INDEX_NAME AS index_name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq_in_index,
			       COLUMN_NAME AS column_name
			FROM information_schema.STATISTICS
			WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
			ORDER BY INDEX_NAME, SEQ_IN_INDEX`;
		const foreignKeysSql = `
			SELECT CONSTRAINT_NAME AS constraint_name, COLUMN_NAME AS column_name,
			       REFERENCED_TABLE_SCHEMA AS ref_schema, REFERENCED_TABLE_NAME AS ref_table,
			       REFERENCED_COLUMN_NAME AS ref_column, ORDINAL_POSITION AS ordinal_position
			FROM information_schema.KEY_COLUMN_USAGE
			WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
			ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`;
		const typeSql = `SELECT TABLE_TYPE AS table_type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`;

		const [[colRows], [idxRows], [fkRows], [typeRows]] = await Promise.all([
			pool.query(columnsSql, [schema, table]),
			pool.query(indexesSql, [schema, table]),
			pool.query(foreignKeysSql, [schema, table]),
			pool.query(typeSql, [schema, table]),
		]);

		const columns: ColumnInfo[] = isRowArray(colRows)
			? (colRows as unknown as MysqlColumnRow[]).map((c) => ({
					name: c.column_name,
					dataType: c.data_type,
					nullable: c.is_nullable === "YES",
					isPrimaryKey: c.is_primary_key === 1 || c.is_primary_key === true,
					defaultValue: c.column_default,
				}))
			: [];
		const indexes = isRowArray(idxRows) ? foldMysqlIndexes(idxRows as unknown as MysqlIndexRow[]) : [];
		const foreignKeys = isRowArray(fkRows) ? foldMysqlForeignKeys(fkRows as unknown as MysqlForeignKeyRow[]) : [];
		const tableType = isRowArray(typeRows)
			? (typeRows[0] as { table_type?: string } | undefined)?.table_type
			: undefined;
		return { schema, name: table, kind: tableType === "VIEW" ? "view" : "table", columns, indexes, foreignKeys };
	}

	async metadataSignature(): Promise<string> {
		// No cheap, reliable remote schema-change probe — rely on the in-process
		// mutation generation (bumped by the service on write/DDL) instead.
		return "";
	}
}

interface MysqlColumnRow {
	column_name: string;
	data_type: string;
	is_nullable: string;
	column_default: string | null;
	is_primary_key: number | boolean;
}
interface MysqlIndexRow {
	index_name: string;
	non_unique: number;
	seq_in_index: number;
	column_name: string;
}
interface MysqlForeignKeyRow {
	constraint_name: string;
	column_name: string;
	ref_schema: string;
	ref_table: string;
	ref_column: string;
	ordinal_position: number;
}

/** Fold flat per-(index,column) rows into one {@link IndexInfo} per index, columns ordered by SEQ_IN_INDEX. */
function foldMysqlIndexes(rows: MysqlIndexRow[]): IndexInfo[] {
	const byName = new Map<string, { info: IndexInfo; cols: Array<{ name: string; seq: number }> }>();
	for (const row of rows) {
		let entry = byName.get(row.index_name);
		if (!entry) {
			entry = {
				info: {
					name: row.index_name,
					columns: [],
					isUnique: row.non_unique === 0,
					isPrimary: row.index_name === "PRIMARY",
				},
				cols: [],
			};
			byName.set(row.index_name, entry);
		}
		entry.cols.push({ name: row.column_name, seq: row.seq_in_index });
	}
	return [...byName.values()].map(({ info, cols }) => ({
		...info,
		columns: cols.sort((a, b) => a.seq - b.seq).map((c) => c.name),
	}));
}

/** Fold flat per-(constraint,column) rows into one {@link ForeignKeyInfo} per constraint. */
function foldMysqlForeignKeys(rows: MysqlForeignKeyRow[]): ForeignKeyInfo[] {
	const byName = new Map<
		string,
		{ row: MysqlForeignKeyRow; cols: Array<{ col: string; ref: string; ord: number }> }
	>();
	for (const row of rows) {
		let entry = byName.get(row.constraint_name);
		if (!entry) {
			entry = { row, cols: [] };
			byName.set(row.constraint_name, entry);
		}
		entry.cols.push({ col: row.column_name, ref: row.ref_column, ord: row.ordinal_position });
	}
	return [...byName.values()].map(({ row, cols }) => {
		const ordered = cols.sort((a, b) => a.ord - b.ord);
		return {
			name: row.constraint_name,
			columns: ordered.map((c) => c.col),
			referencedSchema: row.ref_schema,
			referencedTable: row.ref_table,
			referencedColumns: ordered.map((c) => c.ref),
		};
	});
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
