import { createLogger } from "../logging";
import type { DatabaseDriver } from "./driver/driver";
import { DbConnectionError } from "./errors";
import { getIntrospectionCache, type IntrospectionCache } from "./introspection/introspection-cache";
import { assertOperationAllowed } from "./policy/access-policy";
import type { PoolManager } from "./pool/pool-manager";
import type { ConnectionRecord, DbCredential } from "./registry/connection-store";
import { normalizeConnId, resolveConnectionConfig } from "./registry/connection-store";
import type {
	ConnectionConfig,
	DbCaller,
	QueryResult,
	SchemaIntrospection,
	SchemaSummary,
	TableDetail,
	TableSummary,
	TestConnectionResult,
} from "./types";

const log = createLogger("db:service");

export interface DbServiceDeps {
	poolManager: PoolManager;
	/** Load committed connection metadata by id (from the workspace registry). */
	loadConnection: (connId: string) => Promise<ConnectionRecord | null>;
	/** Load the machine-home secret for a connection id, if configured. */
	loadCredential: (connId: string) => Promise<DbCredential | undefined>;
	/** Process-level metadata cache. Defaults to the shared process-wide instance. */
	introspectionCache?: IntrospectionCache;
}

export interface RunQueryInput {
	connId: string;
	sql: string;
	caller: DbCaller;
	params?: ReadonlyArray<unknown>;
}

export interface IntrospectInput {
	connId: string;
	caller: DbCaller;
}

export interface ListTablesInput extends IntrospectInput {
	schema: string;
}

export interface DescribeTableInput extends IntrospectInput {
	schema: string;
	table: string;
}

/**
 * The single seam the three upper entries (agent / human / cli) use. It owns secret
 * resolution, the policy chokepoint (so it cannot be bypassed), and pool orchestration.
 */
export class DatabaseService {
	private readonly cache: IntrospectionCache;

	constructor(private readonly deps: DbServiceDeps) {
		this.cache = deps.introspectionCache ?? getIntrospectionCache();
	}

	private async resolveDriver(connId: string): Promise<{ record: ConnectionRecord; driver: DatabaseDriver }> {
		const record = await this.deps.loadConnection(connId);
		if (!record) {
			throw new DbConnectionError(`unknown connection: "${connId}"`);
		}
		// A missing credential is a NORMAL state (passwordless / trust auth is valid).
		// Do NOT pre-throw CredentialNotConfiguredError here — pass the undefined credential through
		// so resolveConnectionConfig can build the config without a password, and any actual auth
		// failure will surface at driver connect time as DbConnectionError.
		const credential = await this.deps.loadCredential(connId);
		const config = resolveConnectionConfig(record, credential);
		// SQLite needs the record-level write opt-in to choose its handle mode; pass it through.
		const driverConfig: ConnectionConfig & { allowWrites: boolean } = { ...config, allowWrites: record.allowWrites };
		const driver = await this.deps.poolManager.getDriver(connId, driverConfig);
		return { record, driver };
	}

	async testConnection(connId: string): Promise<TestConnectionResult> {
		const { driver } = await this.resolveDriver(connId);
		return driver.testConnection();
	}

	async runQuery(input: RunQueryInput): Promise<QueryResult> {
		const { record, driver } = await this.resolveDriver(input.connId);
		const resolved = assertOperationAllowed({
			sql: input.sql,
			engine: record.engine,
			caller: input.caller,
			connectionAllowsWrites: record.allowWrites,
		});
		log.debug("running query", { connId: input.connId, caller: input.caller, readOnly: resolved.readOnly });
		const result = await driver.query({ sql: input.sql, params: input.params, readOnly: resolved.readOnly });
		// A successful write/DDL may have changed the schema — drop cached metadata so
		// the next tree expansion reflects it (the read-only path leaves the cache warm).
		if (!resolved.readOnly) {
			this.cache.invalidate(normalizeConnId(input.connId));
		}
		return result;
	}

	async introspect(input: IntrospectInput): Promise<SchemaIntrospection> {
		const { driver } = await this.resolveDriver(input.connId);
		// Introspection is always read-only and bypasses the SQL classifier (driver-internal catalog SQL).
		return driver.introspect();
	}

	/** List the top-level namespaces (schemas / databases / attached files). Cached + always read-only. */
	async listSchemas(input: IntrospectInput): Promise<SchemaSummary[]> {
		const { driver } = await this.resolveDriver(input.connId);
		return this.cache.read(
			normalizeConnId(input.connId),
			"schemas",
			() => driver.metadataSignature(),
			() => driver.listSchemas(),
		);
	}

	/** List the tables/views within one schema. Cached per schema + always read-only. */
	async listTables(input: ListTablesInput): Promise<TableSummary[]> {
		const { driver } = await this.resolveDriver(input.connId);
		return this.cache.read(
			normalizeConnId(input.connId),
			`tables:${input.schema}`,
			() => driver.metadataSignature(),
			() => driver.listTables(input.schema),
		);
	}

	/** Full detail of one table/view (columns, indexes, FKs). Cached per table + always read-only. */
	async describeTable(input: DescribeTableInput): Promise<TableDetail> {
		const { driver } = await this.resolveDriver(input.connId);
		return this.cache.read(
			normalizeConnId(input.connId),
			`table:${input.schema}.${input.table}`,
			() => driver.metadataSignature(),
			() => driver.describeTable(input.schema, input.table),
		);
	}

	/** Drop any live driver for a connection after its registry record changed, and its cached metadata. */
	async invalidate(connId: string): Promise<void> {
		this.cache.invalidate(normalizeConnId(connId));
		await this.deps.poolManager.invalidate(connId);
	}
}
