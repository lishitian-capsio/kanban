import { createLogger } from "../logging";
import { DbConnectionError } from "./errors";
import type { PoolManager } from "./pool/pool-manager";
import { assertOperationAllowed } from "./policy/access-policy";
import type { ConnectionRecord, DbCredential } from "./registry/connection-store";
import { resolveConnectionConfig } from "./registry/connection-store";
import type { ConnectionConfig, DbCaller, QueryResult, SchemaIntrospection, TestConnectionResult } from "./types";
import type { DatabaseDriver } from "./driver/driver";

const log = createLogger("db:service");

export interface DbServiceDeps {
	poolManager: PoolManager;
	/** Load committed connection metadata by id (from the workspace registry). */
	loadConnection: (connId: string) => Promise<ConnectionRecord | null>;
	/** Load the machine-home secret for a connection id, if configured. */
	loadCredential: (connId: string) => Promise<DbCredential | undefined>;
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

/**
 * The single seam the three upper entries (agent / human / cli) use. It owns secret
 * resolution, the policy chokepoint (so it cannot be bypassed), and pool orchestration.
 */
export class DatabaseService {
	constructor(private readonly deps: DbServiceDeps) {}

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
		return driver.query({ sql: input.sql, params: input.params, readOnly: resolved.readOnly });
	}

	async introspect(input: IntrospectInput): Promise<SchemaIntrospection> {
		const { driver } = await this.resolveDriver(input.connId);
		// Introspection is always read-only and bypasses the SQL classifier (driver-internal catalog SQL).
		return driver.introspect();
	}

	/** Drop any live driver for a connection after its registry record changed. */
	async invalidate(connId: string): Promise<void> {
		await this.deps.poolManager.invalidate(connId);
	}
}
