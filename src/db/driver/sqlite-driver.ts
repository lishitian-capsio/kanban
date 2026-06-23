import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { statSync } from "node:fs";

import { createLogger } from "../../logging";
import { DbConnectionError, DbPolicyError, DbQueryError } from "../errors";
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

const log = createLogger("db:sqlite-driver");

function quoteSqliteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Spread-friendly cast of the request bindings to bun:sqlite's accepted shape. */
function asBindings(params: ReadonlyArray<unknown> | undefined): SQLQueryBindings[] {
	return (params ?? []) as SQLQueryBindings[];
}

interface SqliteMasterRow {
	name: string;
	type: string;
}
interface PragmaColumnRow {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}
interface PragmaDatabaseRow {
	seq: number;
	name: string;
	file: string;
}
interface PragmaIndexListRow {
	seq: number;
	name: string;
	unique: number;
	origin: string;
	partial: number;
}
interface PragmaIndexInfoRow {
	seqno: number;
	cid: number;
	name: string | null;
}
interface PragmaForeignKeyRow {
	id: number;
	seq: number;
	table: string;
	from: string;
	to: string | null;
}

/** SQLite adapter on bun:sqlite. Synchronous engine wrapped in the async driver contract. */
export class SqliteDriver implements DatabaseDriver {
	readonly engine = "sqlite" as const;
	private db: Database | null = null;

	constructor(private readonly config: ConnectionConfig & { allowWrites?: boolean }) {}

	async connect(): Promise<void> {
		if (this.db) {
			return;
		}
		if (!this.config.filePath) {
			throw new DbConnectionError("sqlite connection requires a filePath");
		}
		try {
			// Open read-only at the handle level unless the connection opted into writes.
			this.db = new Database(
				this.config.filePath,
				this.config.allowWrites === true ? { readwrite: true, create: true } : { readonly: true },
			);
		} catch (error) {
			throw new DbConnectionError(`failed to open sqlite database: ${String(error)}`);
		}
	}

	async disconnect(): Promise<void> {
		this.db?.close();
		this.db = null;
	}

	private require(): Database {
		if (!this.db) {
			throw new DbConnectionError("sqlite driver is not connected");
		}
		return this.db;
	}

	async testConnection(): Promise<TestConnectionResult> {
		const started = performance.now();
		const db = this.require();
		const version = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
		return { ok: true, latencyMs: performance.now() - started, serverVersion: version.v };
	}

	async query(request: QueryRequest): Promise<QueryResult> {
		const db = this.require();
		const started = performance.now();
		let stmt: Statement;
		try {
			stmt = db.prepare(request.sql);
		} catch (error) {
			throw new DbQueryError(`sqlite prepare failed: ${String(error)}`, error);
		}
		// A row-returning statement (SELECT / PRAGMA / RETURNING) exposes columns;
		// bun:sqlite has no `reader` flag, so column presence is the equivalent signal.
		const isReader = stmt.columnNames.length > 0;
		// DB-level read-only guard (defense-in-depth alongside the policy classifier).
		if (request.readOnly && !isReader) {
			throw new DbPolicyError("statement is not read-only but was requested as read-only");
		}
		try {
			if (isReader) {
				const rows = stmt.all(...asBindings(request.params)) as Array<Record<string, unknown>>;
				// `declaredTypes` is populated after execution and mirrors the schema
				// decltype (closest to better-sqlite3's `column.type`).
				const declaredTypes = stmt.declaredTypes;
				const fields = stmt.columnNames.map((name, index) => ({
					name,
					dataType: declaredTypes[index] ?? undefined,
				}));
				return { rows, fields, rowCount: rows.length, durationMs: performance.now() - started };
			}
			const info = stmt.run(...asBindings(request.params));
			return { rows: [], fields: [], rowCount: info.changes, durationMs: performance.now() - started };
		} catch (error) {
			throw new DbQueryError(`sqlite query failed: ${String(error)}`, error);
		}
	}

	async introspect(): Promise<SchemaIntrospection> {
		const db = this.require();
		const objects = db
			.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")
			.all() as SqliteMasterRow[];
		const tables: TableInfo[] = objects.map((obj) => {
			const cols = db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(obj.name)})`).all() as PragmaColumnRow[];
			const columns: ColumnInfo[] = cols.map((c) => ({
				name: c.name,
				dataType: c.type || "",
				nullable: c.notnull === 0,
				isPrimaryKey: c.pk > 0,
				defaultValue: c.dflt_value,
			}));
			return { schema: "main", name: obj.name, kind: obj.type === "view" ? "view" : "table", columns };
		});
		log.debug("sqlite introspect complete", { tableCount: tables.length });
		return { engine: this.engine, tables };
	}

	async listSchemas(): Promise<SchemaSummary[]> {
		const db = this.require();
		const rows = db.prepare("PRAGMA database_list").all() as PragmaDatabaseRow[];
		return rows.map((r) => ({ name: r.name }));
	}

	async listTables(schema: string): Promise<TableSummary[]> {
		const db = this.require();
		const master = `${quoteSqliteIdentifier(schema)}.sqlite_master`;
		const rows = db
			.prepare(
				`SELECT name, type FROM ${master} WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
			)
			.all() as SqliteMasterRow[];
		return rows.map((r) => ({ schema, name: r.name, kind: r.type === "view" ? "view" : "table" }));
	}

	async describeTable(schema: string, table: string): Promise<TableDetail> {
		const db = this.require();
		const master = `${quoteSqliteIdentifier(schema)}.sqlite_master`;
		const obj = db
			.prepare(`SELECT name, type FROM ${master} WHERE name = ? AND type IN ('table','view')`)
			.get(table) as SqliteMasterRow | null;
		if (!obj) {
			throw new DbQueryError(`sqlite table not found: ${schema}.${table}`);
		}
		const columns = this.readColumns(schema, table);
		const indexes = obj.type === "view" ? [] : this.readIndexes(schema, table);
		const foreignKeys = obj.type === "view" ? [] : this.readForeignKeys(schema, table);
		return { schema, name: table, kind: obj.type === "view" ? "view" : "table", columns, indexes, foreignKeys };
	}

	async metadataSignature(): Promise<string> {
		// In-memory / no-file connections cannot be probed cheaply; fall back to a
		// constant so the cache is gated by the in-process mutation generation only.
		if (!this.config.filePath || this.config.filePath === ":memory:") {
			return "memory";
		}
		try {
			const stat = statSync(this.config.filePath);
			return `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return "missing";
		}
	}

	/** `PRAGMA <schema>.<name>(<table>)` — SQLite qualifies the schema before the pragma name. */
	private pragma(schema: string, name: string, table: string): string {
		return `PRAGMA ${quoteSqliteIdentifier(schema)}.${name}(${quoteSqliteIdentifier(table)})`;
	}

	private readColumns(schema: string, table: string): ColumnInfo[] {
		const db = this.require();
		const cols = db.prepare(this.pragma(schema, "table_info", table)).all() as PragmaColumnRow[];
		return cols.map((c) => ({
			name: c.name,
			dataType: c.type || "",
			nullable: c.notnull === 0,
			isPrimaryKey: c.pk > 0,
			defaultValue: c.dflt_value,
		}));
	}

	private readIndexes(schema: string, table: string): IndexInfo[] {
		const db = this.require();
		const list = db.prepare(this.pragma(schema, "index_list", table)).all() as PragmaIndexListRow[];
		return list.map((idx) => {
			const infos = db.prepare(this.pragma(schema, "index_info", idx.name)).all() as PragmaIndexInfoRow[];
			const columns = infos
				.sort((a, b) => a.seqno - b.seqno)
				.map((info) => info.name)
				.filter((name): name is string => name !== null);
			return { name: idx.name, columns, isUnique: idx.unique === 1, isPrimary: idx.origin === "pk" };
		});
	}

	private readForeignKeys(schema: string, table: string): ForeignKeyInfo[] {
		const db = this.require();
		const rows = db.prepare(this.pragma(schema, "foreign_key_list", table)).all() as PragmaForeignKeyRow[];
		const byId = new Map<number, PragmaForeignKeyRow[]>();
		for (const row of rows) {
			const group = byId.get(row.id) ?? [];
			group.push(row);
			byId.set(row.id, group);
		}
		const fks: ForeignKeyInfo[] = [];
		for (const group of byId.values()) {
			group.sort((a, b) => a.seq - b.seq);
			const first = group[0];
			if (!first) {
				continue;
			}
			const referencedTable = first.table;
			// A null `to` means the FK references the target's PRIMARY KEY implicitly;
			// resolve it to the referenced table's PK columns so WHERE generation is reliable.
			const needsPk = group.some((g) => g.to === null);
			const referencedPk = needsPk ? this.readPrimaryKeyColumns(schema, referencedTable) : [];
			fks.push({
				name: null, // SQLite does not expose FK constraint names via PRAGMA.
				columns: group.map((g) => g.from),
				referencedSchema: schema,
				referencedTable,
				referencedColumns: group.map((g, i) => g.to ?? referencedPk[i] ?? ""),
			});
		}
		return fks;
	}

	private readPrimaryKeyColumns(schema: string, table: string): string[] {
		const db = this.require();
		const cols = db.prepare(this.pragma(schema, "table_info", table)).all() as PragmaColumnRow[];
		return cols
			.filter((c) => c.pk > 0)
			.sort((a, b) => a.pk - b.pk)
			.map((c) => c.name);
	}
}

registerDriver("sqlite", (config) => new SqliteDriver(config as ConnectionConfig & { allowWrites?: boolean }));
