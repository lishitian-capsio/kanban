import { createLogger } from "../../../logging";
import { DbConnectionError, DbPolicyError, DbQueryError } from "../../errors";
import type {
	ColumnInfo,
	ConnectionConfig,
	QueryRequest,
	QueryResult,
	SchemaIntrospection,
	SchemaSummary,
	TableDetail,
	TableInfo,
	TableSummary,
	TestConnectionResult,
} from "../../types";
import type { BrowseKeyspaceInput, BrowseKeyspaceResult, DatabaseDriver, KeyspaceBrowser, RedisKeyspaceRow } from "../driver";
import { registerDriver } from "../driver-registry";
import {
	buildRedisTlsOptions,
	buildRedisUrl,
	defaultRedisClientFactory,
	type RedisClientFactory,
	type RedisClientLike,
} from "./redis-client";
import { isReadOnlyRedisCommand, parseRedisCommandLine } from "./redis-commands";
import { shapeRedisReply } from "./redis-reply-shaper";

const log = createLogger("db:redis-driver");

/** Cap on keys materialized while sweeping to build the prefix "table" list. */
const LIST_TABLES_SCAN_CAP = 10_000;
/** SCAN COUNT hint per iteration. */
const SCAN_COUNT = 500;
/** The synthetic "table" for keys with no ':' delimiter. */
const ROOT_TABLE = "(root)";
/** Delimiter that separates a key's prefix namespace from the rest. */
const KEY_DELIMITER = ":";
/** The fixed synthetic columns a Redis "table" exposes. */
const REDIS_COLUMNS: ColumnInfo[] = [
	{ name: "key", dataType: "string", nullable: false, isPrimaryKey: true, defaultValue: null },
	{ name: "type", dataType: "string", nullable: false, isPrimaryKey: false, defaultValue: null },
	{ name: "ttl", dataType: "integer", nullable: false, isPrimaryKey: false, defaultValue: null },
	{ name: "value", dataType: "string", nullable: true, isPrimaryKey: false, defaultValue: null },
];

/** "db0" → 0; anything unparseable → 0. */
function dbIndex(schema: string): number {
	const n = Number.parseInt(schema.replace(/^db/i, ""), 10);
	return Number.isInteger(n) && n >= 0 ? n : 0;
}

function prefixOf(key: string): string {
	const idx = key.indexOf(KEY_DELIMITER);
	return idx <= 0 ? ROOT_TABLE : key.slice(0, idx);
}

function asString(reply: unknown): string {
	return typeof reply === "string" ? reply : String(reply);
}

function asArrayReply(reply: unknown): [string, string[]] {
	if (Array.isArray(reply) && reply.length === 2 && Array.isArray(reply[1])) {
		return [asString(reply[0]), (reply[1] as unknown[]).map(asString)];
	}
	throw new DbQueryError("unexpected SCAN reply shape");
}

/** Redis adapter on Bun's native `RedisClient`. Strictly read-only: an allowlist gates every command. */
export class RedisDriver implements DatabaseDriver, KeyspaceBrowser {
	readonly engine = "redis" as const;
	private client: RedisClientLike | null = null;

	constructor(
		private readonly config: ConnectionConfig,
		private readonly factory: RedisClientFactory = defaultRedisClientFactory,
	) {}

	async connect(): Promise<void> {
		if (this.client) {
			return;
		}
		const client = this.factory(buildRedisUrl(this.config), buildRedisTlsOptions(this.config));
		try {
			await client.connect();
		} catch (error) {
			throw new DbConnectionError(`failed to connect to redis: ${String(error)}`);
		}
		this.client = client;
	}

	async disconnect(): Promise<void> {
		this.client?.close();
		this.client = null;
	}

	private require(): RedisClientLike {
		if (!this.client) {
			throw new DbConnectionError("redis driver is not connected");
		}
		return this.client;
	}

	private async send(command: string, args: string[]): Promise<unknown> {
		return this.require().send(command, args);
	}

	/** Point the connection at a logical db before a scoped read (SELECT is connection-stateful). */
	private async selectDb(schema: string): Promise<void> {
		await this.send("SELECT", [String(dbIndex(schema))]);
	}

	async testConnection(): Promise<TestConnectionResult> {
		const started = performance.now();
		await this.send("PING", []);
		let serverVersion: string | null = null;
		try {
			const info = asString(await this.send("INFO", ["server"]));
			serverVersion = /redis_version:([^\r\n]+)/.exec(info)?.[1]?.trim() ?? null;
		} catch (error) {
			log.debug("redis INFO failed; version unknown", { error });
		}
		return { ok: true, latencyMs: performance.now() - started, serverVersion };
	}

	async query(request: QueryRequest): Promise<QueryResult> {
		const started = performance.now();
		const { command, args } = parseRedisCommandLine(request.sql);
		// DB-level read-only guard (defense-in-depth alongside the policy classifier).
		if (!isReadOnlyRedisCommand(command)) {
			throw new DbPolicyError("redis command is not read-only");
		}
		try {
			const reply = await this.send(command, args);
			const shaped = shapeRedisReply(command, reply);
			return {
				rows: shaped.rows,
				fields: shaped.fields,
				rowCount: shaped.rows.length,
				durationMs: performance.now() - started,
			};
		} catch (error) {
			if (error instanceof DbPolicyError) {
				throw error;
			}
			throw new DbQueryError(`redis command failed: ${String(error)}`, error);
		}
	}

	async listSchemas(): Promise<SchemaSummary[]> {
		let count = 16;
		try {
			const reply = await this.send("CONFIG", ["GET", "databases"]);
			const parsed = Array.isArray(reply) ? Number.parseInt(asString(reply[1]), 10) : Number.NaN;
			if (Number.isInteger(parsed) && parsed > 0) {
				count = parsed;
			}
		} catch (error) {
			// CONFIG is often disabled on managed/cluster Redis — fall back to a single db.
			log.debug("redis CONFIG GET databases denied; single db0", { error });
			return [{ name: "db0" }];
		}
		return Array.from({ length: count }, (_v, i) => ({ name: `db${i}` }));
	}

	async listTables(schema: string): Promise<TableSummary[]> {
		await this.selectDb(schema);
		const prefixes = new Set<string>();
		let cursor = "0";
		let seen = 0;
		do {
			const [next, keys] = asArrayReply(await this.send("SCAN", [cursor, "COUNT", String(SCAN_COUNT)]));
			for (const key of keys) {
				prefixes.add(prefixOf(key));
			}
			seen += keys.length;
			cursor = next;
			if (seen >= LIST_TABLES_SCAN_CAP) {
				log.warn("redis listTables scan cap hit; prefix list may be incomplete", { schema, seen });
				break;
			}
		} while (cursor !== "0");
		return [...prefixes].sort().map((name) => ({ schema, name, kind: "table" as const }));
	}

	async describeTable(schema: string, table: string): Promise<TableDetail> {
		return { schema, name: table, kind: "table", columns: REDIS_COLUMNS, indexes: [], foreignKeys: [] };
	}

	async introspect(): Promise<SchemaIntrospection> {
		const schemas = await this.listSchemas();
		const tables: TableInfo[] = [];
		for (const schema of schemas) {
			const summaries = await this.listTables(schema.name);
			for (const s of summaries) {
				tables.push({ schema: s.schema, name: s.name, kind: "table", columns: REDIS_COLUMNS });
			}
		}
		return { engine: this.engine, tables };
	}

	async metadataSignature(): Promise<string> {
		return "";
	}

	async browseKeyspace(input: BrowseKeyspaceInput): Promise<BrowseKeyspaceResult> {
		const started = performance.now();
		await this.selectDb(input.schema);
		const match = input.prefix === ROOT_TABLE || input.prefix === "" ? "*" : `${input.prefix}${KEY_DELIMITER}*`;
		const cursor = input.cursor ?? "0";
		const [next, keys] = asArrayReply(
			await this.send("SCAN", [cursor, "MATCH", match, "COUNT", String(input.limit)]),
		);
		// For the "(root)" table, drop keys that actually contain a delimiter (MATCH "*" is broad).
		const filtered = input.prefix === ROOT_TABLE ? keys.filter((k) => !k.includes(KEY_DELIMITER)) : keys;
		const rows: RedisKeyspaceRow[] = [];
		for (const key of filtered) {
			const type = asString(await this.send("TYPE", [key]));
			const ttl = Number(await this.send("TTL", [key]));
			const value = await this.previewValue(key, type, input.valuePreviewLimit);
			rows.push({ key, type, ttl: Number.isFinite(ttl) ? ttl : -1, value });
		}
		return { rows, scanCursor: next, durationMs: performance.now() - started };
	}

	/** Bounded, type-aware value preview rendered as a compact string. */
	private async previewValue(key: string, type: string, limit: number): Promise<string> {
		try {
			switch (type) {
				case "string": {
					const raw = asString(await this.send("GET", [key]));
					return raw.slice(0, limit);
				}
				case "hash": {
					const reply = await this.send("HGETALL", [key]);
					return this.compact(shapeToPairs(reply), limit);
				}
				case "list": {
					const reply = await this.send("LRANGE", [key, "0", String(limit - 1)]);
					return this.compact(Array.isArray(reply) ? reply.map(asString) : [], limit);
				}
				case "set": {
					const reply = await this.send("SSCAN", [key, "0", "COUNT", String(limit)]);
					const members = Array.isArray(reply) && Array.isArray(reply[1]) ? (reply[1] as unknown[]).map(asString) : [];
					return this.compact(members, limit);
				}
				case "zset": {
					const reply = await this.send("ZRANGE", [key, "0", String(limit - 1), "WITHSCORES"]);
					return this.compact(Array.isArray(reply) ? reply.map(asString) : [], limit);
				}
				case "stream": {
					const len = Number(await this.send("XLEN", [key]));
					return `stream(len=${Number.isFinite(len) ? len : "?"})`;
				}
				default:
					return `<${type}>`;
			}
		} catch (error) {
			log.debug("redis value preview failed", { key, type, error });
			return `<${type}>`;
		}
	}

	private compact(items: unknown[] | Record<string, unknown>, limit: number): string {
		const json = JSON.stringify(items);
		return json.length > 0 && Array.isArray(items) && items.length >= limit ? `${json} …(+more)` : json;
	}
}

/** HGETALL reply → an ordered pair array/object usable by `compact`. */
function shapeToPairs(reply: unknown): Record<string, unknown> {
	if (reply && typeof reply === "object" && !Array.isArray(reply)) {
		return reply as Record<string, unknown>;
	}
	const out: Record<string, unknown> = {};
	if (Array.isArray(reply)) {
		for (let i = 0; i + 1 < reply.length; i += 2) {
			out[String(reply[i])] = reply[i + 1];
		}
	}
	return out;
}

registerDriver("redis", (config) => new RedisDriver(config));
