import { readFileSync } from "node:fs";

import type { SQL } from "bun";

import type { ConnectionConfig } from "../../types";

/**
 * The awaited result of a `Bun.SQL` query: an array of row objects. Bun hangs two extra
 * properties off the array — `count` (rows for a read / affected rows for a write) and
 * `command` (e.g. `"SELECT"`, `"INSERT"`). Bun exposes no per-column field metadata, so the
 * driver derives column names from the first row's keys (type ids are unavailable).
 */
export type BunSqlRows = Array<Record<string, unknown>> & { count?: number; command?: string };

/** A single reserved connection pulled from the pool (mirrors `pg` client / `mysql2` connection). */
export interface BunReservedSqlLike {
	unsafe(sql: string, values?: unknown[]): Promise<BunSqlRows>;
	release(): void;
}

/** The minimal `Bun.SQL` surface this driver uses — lets tests inject a fake under vitest. */
export interface BunSqlLike {
	unsafe(sql: string, values?: unknown[]): Promise<BunSqlRows>;
	reserve(): Promise<BunReservedSqlLike>;
	connect(): Promise<unknown>;
	close(options?: { timeout?: number }): Promise<void>;
}

export type BunSqlOptions = SQL.Options;
export type BunSqlFactory = (options: BunSqlOptions) => BunSqlLike;

/** The Postgres/MySQL member of Bun's `SQL.Options` union (excludes the SQLite adapter shape). */
type RemoteSqlOptions = Extract<BunSqlOptions, { adapter?: "postgres" | "mysql" | "mariadb" }>;

/**
 * Default factory: the real Bun-native SQL client. `Bun.SQL` is referenced lazily via the `Bun`
 * global so this module stays importable under Node/vitest, where tests inject a fake and never
 * invoke it. A static `import { SQL } from "bun"` would dlopen native code at import time.
 */
export const defaultBunSqlFactory: BunSqlFactory = (options) => new Bun.SQL(options) as unknown as BunSqlLike;

/**
 * Map a resolved {@link ConnectionConfig} to Bun.SQL connection options for a remote engine,
 * mirroring the SSL handling the old `pg`/`mysql2` drivers used (Kanban's `ssl.mode` →
 * `rejectUnauthorized`; `caPath`/PEM material → Bun's `tls` object).
 */
export function buildRemoteSqlOptions(
	config: ConnectionConfig,
	adapter: "postgres" | "mysql" | "mariadb",
): BunSqlOptions {
	const options: RemoteSqlOptions = {
		adapter,
		hostname: config.host,
		port: config.port,
		database: config.database,
		username: config.user,
		password: config.password,
	};
	if (config.ssl && config.ssl.mode !== "disable") {
		const tls: { rejectUnauthorized: boolean; ca?: string; key?: string; cert?: string } = {
			rejectUnauthorized: config.ssl.mode === "verify-full" || config.ssl.mode === "verify-ca",
		};
		if (config.ssl.caPath) {
			tls.ca = readFileSync(config.ssl.caPath, "utf8");
		}
		if (config.sslKeyPem) {
			tls.key = config.sslKeyPem;
		}
		if (config.sslCertPem) {
			tls.cert = config.sslCertPem;
		}
		options.tls = tls;
	}
	return options;
}
