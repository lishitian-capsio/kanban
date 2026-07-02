import { readFileSync } from "node:fs";

import type { ConnectionConfig } from "../../types";

/** The minimal `RedisClient` surface this driver uses — lets tests inject a fake under vitest. */
export interface RedisClientLike {
	readonly connected: boolean;
	connect(): Promise<void>;
	close(): void;
	send(command: string, args: string[]): Promise<unknown>;
}

/** The subset of Bun `RedisOptions` this driver sets. */
export interface RedisClientOptions {
	tls?: boolean | { rejectUnauthorized?: boolean; ca?: string; key?: string; cert?: string };
}

export type RedisClientFactory = (url: string, options?: RedisClientOptions) => RedisClientLike;

function db(config: ConnectionConfig): string {
	const raw = (config.database ?? "").trim();
	return raw === "" ? "0" : raw;
}

/** Compose a redis:// / rediss:// / redis+unix:// URL from a resolved connection config. */
export function buildRedisUrl(config: ConnectionConfig): string {
	if (config.filePath && config.filePath.trim() !== "") {
		return `redis+unix://${config.filePath.trim()}`;
	}
	const scheme = config.ssl && config.ssl.mode !== "disable" ? "rediss" : "redis";
	const host = config.host ?? "localhost";
	const port = config.port ?? 6379;
	let auth = "";
	if (config.password !== undefined || (config.user ?? "") !== "") {
		const user = encodeURIComponent(config.user ?? "");
		const pass = config.password !== undefined ? `:${encodeURIComponent(config.password)}` : "";
		auth = `${user}${pass}@`;
	}
	return `${scheme}://${auth}${host}:${port}/${db(config)}`;
}

/** Map Kanban SSL config to Bun `RedisOptions.tls`, mirroring the bun-sql SSL handling. */
export function buildRedisTlsOptions(config: ConnectionConfig): RedisClientOptions | undefined {
	if (!config.ssl || config.ssl.mode === "disable") {
		return undefined;
	}
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
	return { tls };
}

/**
 * Default factory: the real Bun-native `RedisClient`. `Bun` is referenced lazily via the global
 * so this module stays importable under Node/vitest, where tests inject a fake and never invoke
 * it. A static `import { RedisClient } from "bun"` would dlopen native code at import time.
 */
export const defaultRedisClientFactory: RedisClientFactory = (url, options) =>
	new Bun.RedisClient(url, options as never) as unknown as RedisClientLike;
