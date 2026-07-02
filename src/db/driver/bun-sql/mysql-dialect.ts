import { createLogger } from "../../../logging";
import type {
	ColumnInfo,
	ConnectionConfig,
	DatabaseEngine,
	ForeignKeyInfo,
	IndexInfo,
	SchemaIntrospection,
	SchemaSummary,
	TableDetail,
	TableInfo,
	TableSummary,
} from "../../types";
import { type BunSqlOptions, buildRemoteSqlOptions } from "./bun-sql";
import type { EngineDialect, RowRunner } from "./dialect";

const log = createLogger("db:bun-mysql-dialect");

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

const INTROSPECT_SQL = `
	SELECT c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type,
	       c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
	       c.COLUMN_DEFAULT AS column_default, (c.COLUMN_KEY = 'PRI') AS is_primary_key
	FROM information_schema.COLUMNS c
	JOIN information_schema.TABLES t
	  ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
	WHERE c.TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
	ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`;

const LIST_SCHEMAS_SQL = `
	SELECT SCHEMA_NAME AS schema_name
	FROM information_schema.SCHEMATA
	WHERE SCHEMA_NAME NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
	ORDER BY SCHEMA_NAME`;

const LIST_TABLES_SQL = `
	SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type
	FROM information_schema.TABLES
	WHERE TABLE_SCHEMA = ?
	ORDER BY TABLE_NAME`;

const DESCRIBE_COLUMNS_SQL = `
	SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable,
	       COLUMN_DEFAULT AS column_default, (COLUMN_KEY = 'PRI') AS is_primary_key
	FROM information_schema.COLUMNS
	WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
	ORDER BY ORDINAL_POSITION`;

const DESCRIBE_INDEXES_SQL = `
	SELECT INDEX_NAME AS index_name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq_in_index,
	       COLUMN_NAME AS column_name
	FROM information_schema.STATISTICS
	WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
	ORDER BY INDEX_NAME, SEQ_IN_INDEX`;

const DESCRIBE_FKS_SQL = `
	SELECT CONSTRAINT_NAME AS constraint_name, COLUMN_NAME AS column_name,
	       REFERENCED_TABLE_SCHEMA AS ref_schema, REFERENCED_TABLE_NAME AS ref_table,
	       REFERENCED_COLUMN_NAME AS ref_column, ORDINAL_POSITION AS ordinal_position
	FROM information_schema.KEY_COLUMN_USAGE
	WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
	ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`;

const TABLE_TYPE_SQL = `SELECT TABLE_TYPE AS table_type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`;

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

function groupColumnsIntoTables(rows: Array<Record<string, unknown>>): TableInfo[] {
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

/** Per-engine knobs for a MySQL-protocol dialect. Introspection SQL and quoting are shared. */
interface MysqlDialectOptions {
	engine: DatabaseEngine;
	/** Bun.SQL adapter — MySQL uses `mysql`; MariaDB has its own protocol-aware `mariadb` adapter. */
	adapter: "mysql" | "mariadb";
	/** Server-side statement-timeout statement. Defaults to MySQL's `SET max_execution_time` (ms). */
	timeoutStatement?: (ms: number) => string;
	/** Reset statement for the session-scoped timeout variable, cleared before the connection is pooled. */
	resetTimeoutStatement: string;
}

/**
 * Build a MySQL-wire-protocol dialect. `mysql` and `mariadb` share the `information_schema`
 * introspection SQL and backtick quoting; they differ in the Bun.SQL adapter and the statement
 * timeout: MySQL's `max_execution_time` is milliseconds and SELECT-only, while MariaDB has no such
 * variable and instead uses `max_statement_time`, which is measured in **seconds** (a decimal).
 */
export function createMysqlDialect(options: MysqlDialectOptions): EngineDialect {
	const { engine, adapter } = options;
	return {
		engine,
		buildOptions(config: ConnectionConfig): BunSqlOptions {
			return buildRemoteSqlOptions(config, adapter);
		},
		versionSql: "SELECT VERSION() AS v",
		beginReadOnly: "START TRANSACTION READ ONLY",
		timeoutStatement: options.timeoutStatement ?? ((ms: number) => `SET max_execution_time = ${ms}`),
		// Session-scoped variable — reset before the connection returns to the pool so it never leaks.
		resetTimeoutStatement: options.resetTimeoutStatement,
		async introspect(run: RowRunner): Promise<SchemaIntrospection> {
			const rows = await run(INTROSPECT_SQL);
			const tables = groupColumnsIntoTables(rows);
			log.debug("mysql-family introspect complete", { engine, tableCount: tables.length });
			return { engine, tables };
		},
		async listSchemas(run: RowRunner): Promise<SchemaSummary[]> {
			const rows = (await run(LIST_SCHEMAS_SQL)) as Array<{ schema_name: string }>;
			return rows.map((r) => ({ name: r.schema_name }));
		},
		async listTables(run: RowRunner, schema: string): Promise<TableSummary[]> {
			const rows = (await run(LIST_TABLES_SQL, [schema])) as Array<{ table_name: string; table_type: string }>;
			return rows.map((r) => ({ schema, name: r.table_name, kind: r.table_type === "VIEW" ? "view" : "table" }));
		},
		async describeTable(run: RowRunner, schema: string, table: string): Promise<TableDetail> {
			const [colRows, idxRows, fkRows, typeRows] = await Promise.all([
				run(DESCRIBE_COLUMNS_SQL, [schema, table]),
				run(DESCRIBE_INDEXES_SQL, [schema, table]),
				run(DESCRIBE_FKS_SQL, [schema, table]),
				run(TABLE_TYPE_SQL, [schema, table]),
			]);
			const columns: ColumnInfo[] = (colRows as unknown as MysqlColumnRow[]).map((c) => ({
				name: c.column_name,
				dataType: c.data_type,
				nullable: c.is_nullable === "YES",
				isPrimaryKey: c.is_primary_key === 1 || c.is_primary_key === true,
				defaultValue: c.column_default,
			}));
			const indexes = foldMysqlIndexes(idxRows as unknown as MysqlIndexRow[]);
			const foreignKeys = foldMysqlForeignKeys(fkRows as unknown as MysqlForeignKeyRow[]);
			const tableType = (typeRows[0] as { table_type?: string } | undefined)?.table_type;
			return { schema, name: table, kind: tableType === "VIEW" ? "view" : "table", columns, indexes, foreignKeys };
		},
	};
}

/** Standard MySQL. */
export const mysqlDialect: EngineDialect = createMysqlDialect({
	engine: "mysql",
	adapter: "mysql",
	resetTimeoutStatement: "SET max_execution_time = 0",
});

/**
 * MariaDB: MySQL-wire-compatible, but has no `max_execution_time`. Its equivalent, `max_statement_time`,
 * is measured in seconds (a decimal), so the millisecond deadline is divided by 1000.
 */
export const mariadbDialect: EngineDialect = createMysqlDialect({
	engine: "mariadb",
	adapter: "mariadb",
	timeoutStatement: (ms: number) => `SET max_statement_time = ${ms / 1000}`,
	resetTimeoutStatement: "SET max_statement_time = 0",
});
