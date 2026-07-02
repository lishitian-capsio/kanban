import type {
	ConnectionConfig,
	DatabaseEngine,
	FieldInfo,
	QueryResult,
	SchemaIntrospection,
	SchemaSummary,
	TableDetail,
	TableSummary,
} from "../../types";
import type { BunSqlOptions, BunSqlRows } from "./bun-sql";

/** Runs one read-only catalog query and returns its rows. Provided by the driver's live pool. */
export type RowRunner = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/**
 * The per-engine specialization the shared {@link import("./bun-sql-driver").BunSqlDriver} composes.
 * Everything that differs between Postgres and MySQL — connection options, the read-only transaction
 * opener, the server-side timeout statement, and the catalog introspection SQL — lives here; the
 * driver core (connect / reserve / query / result-shaping) is engine-agnostic.
 */
export interface EngineDialect {
	readonly engine: DatabaseEngine;
	/** Build the Bun.SQL connection options for this engine. */
	buildOptions(config: ConnectionConfig): BunSqlOptions;
	/** Cheap server-version probe, e.g. `SELECT version() AS v`. */
	readonly versionSql: string;
	/** Opening statement of a read-only transaction (`BEGIN …`/`START TRANSACTION READ ONLY`). */
	readonly beginReadOnly: string;
	/** Server-side statement-timeout statement for a positive `ms` deadline. */
	timeoutStatement(ms: number): string;
	/**
	 * Statement that resets the server-side timeout before the connection returns to the pool, or
	 * null when none is needed. Postgres uses `SET LOCAL` (rolled back with the tx → no reset);
	 * MySQL sets a session var that must be cleared so the limit never leaks to the next borrower.
	 */
	readonly resetTimeoutStatement: string | null;
	introspect(run: RowRunner): Promise<SchemaIntrospection>;
	listSchemas(run: RowRunner): Promise<SchemaSummary[]>;
	listTables(run: RowRunner, schema: string): Promise<TableSummary[]>;
	describeTable(run: RowRunner, schema: string, table: string): Promise<TableDetail>;
}

/**
 * Shape a Bun.SQL result array into the engine-agnostic {@link QueryResult}. Column names are
 * derived from the first row's keys (Bun exposes no field/type metadata), so a zero-row read
 * carries no columns and per-column type ids are always absent — an accepted fidelity trade for
 * the native-driver performance win. `rowCount` uses Bun's `count` (rows for a read, affected
 * rows for a write); it falls back to the array length if `count` is absent.
 *
 * Bun hangs `count`/`command`/`affectedRows` off the result array as enumerable own properties, so
 * the rows are spread into a plain array before being returned — otherwise those extras would leak
 * into the contract-shaped result (visible to `Object.keys` / deep comparisons downstream).
 */
export function toQueryResult(rows: BunSqlRows, startedMs: number): QueryResult {
	const first = rows[0];
	const fields: FieldInfo[] = first ? Object.keys(first).map((name) => ({ name })) : [];
	const rowCount = typeof rows.count === "number" ? rows.count : rows.length;
	return { rows: [...rows], fields, rowCount, durationMs: performance.now() - startedMs };
}
