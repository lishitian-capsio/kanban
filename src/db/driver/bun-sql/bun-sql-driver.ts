import { DbConnectionError, DbQueryError } from "../../errors";
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
} from "../../types";
import type { DatabaseDriver } from "../driver";
import { serverTimeoutMs } from "../driver-timeout";
import { type BunSqlFactory, type BunSqlLike, defaultBunSqlFactory } from "./bun-sql";
import { type EngineDialect, type RowRunner, toQueryResult } from "./dialect";

/**
 * A remote-engine driver on Bun's native `SQL` client. One class serves both Postgres and MySQL:
 * everything engine-specific (connection options, the read-only transaction opener, the
 * server-side timeout statement, and catalog introspection) is delegated to an {@link EngineDialect};
 * this core owns connection management, the read-only transaction (via a reserved connection), and
 * result shaping. It implements exactly the {@link DatabaseDriver} contract, so the pool manager and
 * service treat it identically to the SQLite driver. The `sqlFactory` seam lets tests inject a fake
 * under vitest (where `Bun.SQL` is unavailable); the runtime uses the real client.
 */
export class BunSqlDriver implements DatabaseDriver {
	readonly engine: DatabaseEngine;
	private sql: BunSqlLike | null = null;

	constructor(
		private readonly config: ConnectionConfig,
		private readonly dialect: EngineDialect,
		private readonly sqlFactory: BunSqlFactory = defaultBunSqlFactory,
	) {
		this.engine = dialect.engine;
	}

	async connect(): Promise<void> {
		if (this.sql) {
			return;
		}
		const sql = this.sqlFactory(this.dialect.buildOptions(this.config));
		try {
			await sql.connect();
		} catch (error) {
			throw new DbConnectionError(`failed to connect to ${this.engine}: ${String(error)}`);
		}
		this.sql = sql;
	}

	async disconnect(): Promise<void> {
		await this.sql?.close();
		this.sql = null;
	}

	private require(): BunSqlLike {
		if (!this.sql) {
			throw new DbConnectionError(`${this.engine} driver is not connected`);
		}
		return this.sql;
	}

	/** A read-only catalog runner bound to the live pool, handed to the dialect's introspection. */
	private runner(): RowRunner {
		const sql = this.require();
		return (text, params) => sql.unsafe(text, params ?? []);
	}

	async testConnection(): Promise<TestConnectionResult> {
		const started = performance.now();
		const rows = await this.require().unsafe(this.dialect.versionSql);
		const version = (rows[0]?.v as string | undefined) ?? null;
		return { ok: true, latencyMs: performance.now() - started, serverVersion: version };
	}

	async query(request: QueryRequest): Promise<QueryResult> {
		const sql = this.require();
		const started = performance.now();
		const params = request.params ? [...request.params] : [];
		if (request.readOnly) {
			const reserved = await sql.reserve();
			const timeoutMs = serverTimeoutMs(request.timeoutMs);
			try {
				await reserved.unsafe(this.dialect.beginReadOnly);
				// Server-side deadline: the DATABASE cancels a runaway query at the deadline, not just
				// the in-process timeout (which leaves the query consuming server resources).
				if (timeoutMs > 0) {
					await reserved.unsafe(this.dialect.timeoutStatement(timeoutMs));
				}
				const rows = await reserved.unsafe(request.sql, params);
				await reserved.unsafe("COMMIT");
				return toQueryResult(rows, started);
			} catch (error) {
				try {
					await reserved.unsafe("ROLLBACK");
				} catch {
					// best-effort rollback
				}
				throw new DbQueryError(`${this.engine} query failed: ${String(error)}`, error);
			} finally {
				// Reset a session-scoped timeout before returning the connection to the pool so it never leaks.
				if (timeoutMs > 0 && this.dialect.resetTimeoutStatement) {
					try {
						await reserved.unsafe(this.dialect.resetTimeoutStatement);
					} catch {
						// best-effort reset
					}
				}
				reserved.release();
			}
		}
		try {
			const rows = await sql.unsafe(request.sql, params);
			return toQueryResult(rows, started);
		} catch (error) {
			throw new DbQueryError(`${this.engine} query failed: ${String(error)}`, error);
		}
	}

	introspect(): Promise<SchemaIntrospection> {
		return this.dialect.introspect(this.runner());
	}

	listSchemas(): Promise<SchemaSummary[]> {
		return this.dialect.listSchemas(this.runner());
	}

	listTables(schema: string): Promise<TableSummary[]> {
		return this.dialect.listTables(this.runner(), schema);
	}

	describeTable(schema: string, table: string): Promise<TableDetail> {
		return this.dialect.describeTable(this.runner(), schema, table);
	}

	async metadataSignature(): Promise<string> {
		// No cheap, reliable remote schema-change probe — rely on the in-process
		// mutation generation (bumped by the service on write/DDL) instead.
		return "";
	}
}
