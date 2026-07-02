import { createLogger } from "../../../logging";
import type {
	ColumnInfo,
	ConnectionConfig,
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

const log = createLogger("db:bun-postgres-dialect");

interface PgColumnRow {
	column_name: string;
	data_type: string;
	is_nullable: string;
	column_default: string | null;
	is_primary_key: boolean;
}
interface PgIndexRow {
	index_name: string;
	is_unique: boolean;
	is_primary: boolean;
	column_name: string;
	ord: number;
}
interface PgForeignKeyRow {
	fk_name: string;
	column_name: string;
	ref_schema: string;
	ref_table: string;
	ref_column: string;
	ord: number;
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

const INTROSPECT_SQL = `
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

const LIST_SCHEMAS_SQL = `
	SELECT schema_name
	FROM information_schema.schemata
	WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
	  AND schema_name NOT LIKE 'pg_temp%'
	  AND schema_name NOT LIKE 'pg_toast%'
	ORDER BY schema_name`;

const LIST_TABLES_SQL = `
	SELECT table_name, table_type
	FROM information_schema.tables
	WHERE table_schema = $1
	ORDER BY table_name`;

const DESCRIBE_COLUMNS_SQL = `
	SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
	       (pk.column_name IS NOT NULL) AS is_primary_key
	FROM information_schema.columns c
	LEFT JOIN (
	  SELECT kcu.column_name
	  FROM information_schema.table_constraints tc
	  JOIN information_schema.key_column_usage kcu
	    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
	  WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
	) pk ON pk.column_name = c.column_name
	WHERE c.table_schema = $1 AND c.table_name = $2
	ORDER BY c.ordinal_position`;

const DESCRIBE_INDEXES_SQL = `
	SELECT i.relname AS index_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
	       a.attname AS column_name, k.ord AS ord
	FROM pg_index ix
	JOIN pg_class t ON t.oid = ix.indrelid
	JOIN pg_namespace n ON n.oid = t.relnamespace
	JOIN pg_class i ON i.oid = ix.indexrelid
	JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
	JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
	WHERE n.nspname = $1 AND t.relname = $2
	ORDER BY i.relname, k.ord`;

const DESCRIBE_FKS_SQL = `
	SELECT con.conname AS fk_name, att.attname AS column_name,
	       ref_ns.nspname AS ref_schema, ref_cl.relname AS ref_table, ref_att.attname AS ref_column,
	       k.ord AS ord
	FROM pg_constraint con
	JOIN pg_class cl ON cl.oid = con.conrelid
	JOIN pg_namespace ns ON ns.oid = cl.relnamespace
	JOIN pg_class ref_cl ON ref_cl.oid = con.confrelid
	JOIN pg_namespace ref_ns ON ref_ns.oid = ref_cl.relnamespace
	JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
	JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
	JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord2) ON fk.ord2 = k.ord
	JOIN pg_attribute ref_att ON ref_att.attrelid = con.confrelid AND ref_att.attnum = fk.attnum
	WHERE con.contype = 'f' AND ns.nspname = $1 AND cl.relname = $2
	ORDER BY con.conname, k.ord`;

const TABLE_TYPE_SQL = `SELECT table_type FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`;

/** Fold flat per-(index,column) rows into one {@link IndexInfo} per index, columns ordered by `ord`. */
function foldPgIndexes(rows: PgIndexRow[]): IndexInfo[] {
	const byName = new Map<string, { info: IndexInfo; cols: Array<{ name: string; ord: number }> }>();
	for (const row of rows) {
		let entry = byName.get(row.index_name);
		if (!entry) {
			entry = {
				info: { name: row.index_name, columns: [], isUnique: row.is_unique, isPrimary: row.is_primary },
				cols: [],
			};
			byName.set(row.index_name, entry);
		}
		entry.cols.push({ name: row.column_name, ord: row.ord });
	}
	return [...byName.values()].map(({ info, cols }) => ({
		...info,
		columns: cols.sort((a, b) => a.ord - b.ord).map((c) => c.name),
	}));
}

/** Fold flat per-(constraint,column) rows into one {@link ForeignKeyInfo} per constraint. */
function foldPgForeignKeys(rows: PgForeignKeyRow[]): ForeignKeyInfo[] {
	const byName = new Map<string, { row: PgForeignKeyRow; cols: Array<{ col: string; ref: string; ord: number }> }>();
	for (const row of rows) {
		let entry = byName.get(row.fk_name);
		if (!entry) {
			entry = { row, cols: [] };
			byName.set(row.fk_name, entry);
		}
		entry.cols.push({ col: row.column_name, ref: row.ref_column, ord: row.ord });
	}
	return [...byName.values()].map(({ row, cols }) => {
		const ordered = cols.sort((a, b) => a.ord - b.ord);
		return {
			name: row.fk_name,
			columns: ordered.map((c) => c.col),
			referencedSchema: row.ref_schema,
			referencedTable: row.ref_table,
			referencedColumns: ordered.map((c) => c.ref),
		};
	});
}

/** Fold an ordered flat column result into TableInfo[] (shared shape across SQL engines). */
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
			isPrimaryKey: raw.is_primary_key === true,
			defaultValue: raw.column_default,
		};
		table.columns.push(column);
	}
	return [...byTable.values()];
}

export const postgresDialect: EngineDialect = {
	engine: "postgres",
	buildOptions(config: ConnectionConfig): BunSqlOptions {
		return buildRemoteSqlOptions(config, "postgres");
	},
	versionSql: "SELECT version() AS v",
	beginReadOnly: "BEGIN TRANSACTION READ ONLY",
	timeoutStatement(ms: number): string {
		// Transaction-scoped: rolled back with the tx, so it never leaks to the pooled connection.
		return `SET LOCAL statement_timeout = ${ms}`;
	},
	resetTimeoutStatement: null,
	async introspect(run: RowRunner): Promise<SchemaIntrospection> {
		const rows = await run(INTROSPECT_SQL);
		const tables = groupColumnsIntoTables(rows);
		log.debug("postgres introspect complete", { tableCount: tables.length });
		return { engine: "postgres", tables };
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
		const [colsRes, idxRes, fkRes, kindRes] = await Promise.all([
			run(DESCRIBE_COLUMNS_SQL, [schema, table]),
			run(DESCRIBE_INDEXES_SQL, [schema, table]),
			run(DESCRIBE_FKS_SQL, [schema, table]),
			run(TABLE_TYPE_SQL, [schema, table]),
		]);
		const columns = (colsRes as unknown as PgColumnRow[]).map((c) => ({
			name: c.column_name,
			dataType: c.data_type,
			nullable: c.is_nullable === "YES",
			isPrimaryKey: c.is_primary_key === true,
			defaultValue: c.column_default,
		}));
		const indexes = foldPgIndexes(idxRes as unknown as PgIndexRow[]);
		const foreignKeys = foldPgForeignKeys(fkRes as unknown as PgForeignKeyRow[]);
		const kind = (kindRes[0] as { table_type?: string } | undefined)?.table_type === "VIEW" ? "view" : "table";
		return { schema, name: table, kind, columns, indexes, foreignKeys };
	},
};
