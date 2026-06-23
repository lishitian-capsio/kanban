import Database from "better-sqlite3";

import { createLogger } from "../../logging";
import { DbConnectionError, DbPolicyError, DbQueryError } from "../errors";
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

const log = createLogger("db:sqlite-driver");

function quoteSqliteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
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

/** SQLite adapter on better-sqlite3. Synchronous engine wrapped in the async driver contract. */
export class SqliteDriver implements DatabaseDriver {
	readonly engine = "sqlite" as const;
	private db: Database.Database | null = null;

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
			this.db = new Database(this.config.filePath, { readonly: this.config.allowWrites !== true });
		} catch (error) {
			throw new DbConnectionError(`failed to open sqlite database: ${String(error)}`);
		}
	}

	async disconnect(): Promise<void> {
		this.db?.close();
		this.db = null;
	}

	private require(): Database.Database {
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
		let stmt: Database.Statement;
		try {
			stmt = db.prepare(request.sql);
		} catch (error) {
			throw new DbQueryError(`sqlite prepare failed: ${String(error)}`, error);
		}
		// DB-level read-only guard (defense-in-depth alongside the policy classifier).
		if (request.readOnly && !stmt.reader) {
			throw new DbPolicyError("statement is not read-only but was requested as read-only");
		}
		try {
			if (stmt.reader) {
				const rows = (request.params ? stmt.all(...request.params) : stmt.all()) as Array<Record<string, unknown>>;
				const fields = stmt.columns().map((c) => ({ name: c.name, dataType: c.type ?? undefined }));
				return { rows, fields, rowCount: rows.length, durationMs: performance.now() - started };
			}
			const info = request.params ? stmt.run(...request.params) : stmt.run();
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
}

registerDriver("sqlite", (config) => new SqliteDriver(config as ConnectionConfig & { allowWrites?: boolean }));
