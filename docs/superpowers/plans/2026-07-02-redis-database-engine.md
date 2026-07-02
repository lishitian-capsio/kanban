# Redis Database Engine (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strictly read-only `redis` engine to Kanban's Database feature, built on Bun-native `Bun.redis` (`RedisClient`), browsable in the Database view, `kanban db` CLI, and tRPC.

**Architecture:** A new `RedisDriver` implements the existing `DatabaseDriver` contract plus a new optional `KeyspaceBrowser` capability. Redis KV maps onto the `schemas → tables → detail → browse` tree as: schema = logical db (`db0…dbN`), table = key prefix, columns = fixed `key/type/ttl/value`. All driver ops go through `RedisClient.send(command, args)` so a test fake needs only `send`. Read-only is enforced by a command allowlist (Redis has no SQL read-only session mode). The `QueryResult` contract gains an optional `scanCursor` and the driver gains an optional `browseKeyspace`; SQL engines are unaffected.

**Tech Stack:** TypeScript, Bun 1.3.x (`RedisClient` from `bun`), Zod, tRPC, Commander, React + Tailwind (web-ui), Vitest (Node) + `bun test` (real Redis).

## Global Constraints

- No `any` types unless absolutely necessary; prefer SDK/contract types.
- No inline/dynamic imports — top-level `import` only (`import type` for Bun types).
- Redis driver module MUST be importable under Node/vitest with zero side effects and MUST NOT touch the `Bun` global at import time (reference `Bun` lazily inside a factory, mirroring `defaultBunSqlFactory`).
- vitest tests live under `test/runtime/db/`; real-Bun tests live under `test/bun/db/` (`bun test`). Run vitest with `--exclude='**/.kanban/**'`.
- Redis connections are ALWAYS read-only in this release: `allowWrites` forced `false` on the backend; no write/row-edit path; the allowlist is the enforcement mechanism.
- Logging via `createLogger("<namespace>")`; never `console.*`. Structured context in the fields object.
- Do NOT commit unless the user asks (project rule overrides the plan's per-task commit steps — run the `git add/commit` steps only if the user has authorized commits; otherwise stop after the passing-test step).
- Read-only command allowlist (verbatim, uppercase): `GET GETRANGE STRLEN SUBSTR MGET EXISTS TYPE TTL PTTL EXPIRETIME PEXPIRETIME OBJECT DUMP HGET HGETALL HMGET HKEYS HVALS HLEN HEXISTS HSCAN HSTRLEN HRANDFIELD LRANGE LLEN LINDEX LPOS SMEMBERS SISMEMBER SMISMEMBER SCARD SSCAN SRANDMEMBER SINTERCARD ZRANGE ZRANGEBYSCORE ZRANGEBYLEX ZREVRANGE ZREVRANGEBYSCORE ZCARD ZCOUNT ZSCORE ZMSCORE ZRANK ZREVRANK ZSCAN ZLEXCOUNT SCAN KEYS DBSIZE RANDOMKEY MEMORY XLEN XRANGE XREVRANGE XINFO PING INFO GEOPOS GEODIST GEOSEARCH BITCOUNT GETBIT`.

---

## File Structure

**Create:**
- `src/db/driver/redis/redis-commands.ts` — allowlist set + `parseRedisCommandLine` + `isReadOnlyRedisCommand` (pure).
- `src/db/driver/redis/redis-reply-shaper.ts` — `shapeRedisReply(command, reply)` → `{ rows, fields }` (pure).
- `src/db/driver/redis/redis-client.ts` — `RedisClientLike` interface, `buildRedisUrl(config)`, `buildRedisTlsOptions(config)`, `defaultRedisClientFactory` (lazy `Bun`).
- `src/db/driver/redis/redis-driver.ts` — `RedisDriver implements DatabaseDriver, KeyspaceBrowser`.
- `src/db/driver/redis/register.ts` — `registerDriver("redis", …)` side effect.
- `test/runtime/db/redis-commands.test.ts`, `redis-reply-shaper.test.ts`, `redis-client.test.ts`, `redis-driver.test.ts`.
- `test/bun/db/redis-driver.test.ts` — real connection, gated on `REDIS_TEST_URL`.

**Modify:**
- `src/db/types.ts` — `DatabaseEngine` +`"redis"`; `QueryResult.scanCursor?`.
- `src/db/driver/driver.ts` — `KeyspaceBrowser` interface + `isKeyspaceBrowser` guard; `RedisKeyspaceRow` type.
- `src/db/registry/connection-record.ts` — `databaseEngineSchema` +`"redis"`.
- `src/core/api-contract.ts` — `runtimeDbEngineSchema` +`"redis"`.
- `src/db/policy/sql-classifier.ts` — redis branch.
- `src/db/execution/query-bounds.ts` — redis skips LIMIT wrap.
- `src/db/execution/query-executor.ts` — `browseTable` dispatch to keyspace browse for redis.
- `src/db/db-service.ts` — `browseKeyspace()` method.
- `src/db/index.ts` — `import "./driver/redis/register"` + re-exports.
- `src/trpc/db-api.ts` — engine passthrough already generic (verify); browse works via executor dispatch.
- `src/trpc/workspace-db-api.ts` — redis branch in `browseTable`.
- `src/commands/db.ts` — `VALID_ENGINES` +`"redis"`.
- `web-ui/src/components/database/connection-dialog.tsx` — redis label/port/fields, hide allow-writes.
- `web-ui/src/components/database/database-sidebar.tsx` — `ENGINE_TAG` +redis.
- `AGENTS.md` — tribal-knowledge note.

---

### Task 1: Contract foundation — engine enum, `scanCursor`, `KeyspaceBrowser`

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/driver/driver.ts`
- Modify: `src/db/registry/connection-record.ts`
- Modify: `src/core/api-contract.ts`
- Test: `test/runtime/db/driver-registry.test.ts` (extend), `test/runtime/db/connection-store.test.ts` (extend)

**Interfaces:**
- Produces: `DatabaseEngine` now includes `"redis"`. `QueryResult.scanCursor?: string`. New `interface KeyspaceBrowser { browseKeyspace(input: BrowseKeyspaceInput): Promise<BrowseKeyspaceResult>; }`, `function isKeyspaceBrowser(d: DatabaseDriver): d is DatabaseDriver & KeyspaceBrowser`. Types `BrowseKeyspaceInput`, `BrowseKeyspaceResult`, `RedisKeyspaceRow`.

- [ ] **Step 1: Write the failing test**

Append to `test/runtime/db/connection-store.test.ts` (inside an existing `describe`, or a new one):

```ts
import { databaseEngineSchema } from "../../../src/db/registry/connection-record";

describe("databaseEngineSchema redis", () => {
	it("accepts redis", () => {
		expect(databaseEngineSchema.parse("redis")).toBe("redis");
	});
});
```

Create `test/runtime/db/driver-registry.test.ts` additions (or a new test file) for the guard:

```ts
import { describe, expect, it } from "vitest";
import { isKeyspaceBrowser } from "../../../src/db/driver/driver";

describe("isKeyspaceBrowser", () => {
	it("is false for an object without browseKeyspace", () => {
		expect(isKeyspaceBrowser({ engine: "sqlite" } as never)).toBe(false);
	});
	it("is true when browseKeyspace is a function", () => {
		expect(isKeyspaceBrowser({ engine: "redis", browseKeyspace: () => undefined } as never)).toBe(true);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run test/runtime/db/connection-store.test.ts test/runtime/db/driver-registry.test.ts`
Expected: FAIL — `isKeyspaceBrowser` not exported / `"redis"` rejected.

- [ ] **Step 3: Implement contract changes**

In `src/db/types.ts` line 2:

```ts
export type DatabaseEngine = "postgres" | "mysql" | "sqlite" | "redis";
```

In `src/db/types.ts`, add to the `QueryResult` interface (after `durationMs`):

```ts
	/**
	 * Engine-native continuation token (Redis SCAN cursor). "0" means the scan is complete.
	 * Present only for engines that page natively; SQL drivers leave it undefined and the
	 * executor falls back to the +1-probe-row heuristic.
	 */
	scanCursor?: string;
```

In `src/db/driver/driver.ts`, append the capability interface + guard + row shape:

```ts
/** One row of a Redis keyspace browse: a key plus its type, TTL, and a bounded value preview. */
export interface RedisKeyspaceRow {
	key: string;
	type: string;
	/** Redis TTL in seconds; -1 = no expiry, -2 = missing (raced away). */
	ttl: number;
	/** Bounded, human-readable value preview rendered per type. */
	value: string;
}

export interface BrowseKeyspaceInput {
	/** Logical db name, e.g. "db0". */
	schema: string;
	/** Key prefix (the segment before the first ':'); "" browses the "(root)" no-delimiter keys. */
	prefix: string;
	/** SCAN cursor to resume from; null/undefined starts a fresh scan at "0". */
	cursor: string | null;
	/** Max keys to materialize this page. */
	limit: number;
	/** Per-value preview element/byte budget. */
	valuePreviewLimit: number;
}

export interface BrowseKeyspaceResult {
	rows: RedisKeyspaceRow[];
	/** The SCAN cursor to resume from; "0" when the scan is complete. */
	scanCursor: string;
	durationMs: number;
}

/**
 * Optional driver capability for KV engines that browse a keyspace instead of SQL tables.
 * SQL drivers do not implement it; the executor feature-detects via {@link isKeyspaceBrowser}.
 */
export interface KeyspaceBrowser {
	browseKeyspace(input: BrowseKeyspaceInput): Promise<BrowseKeyspaceResult>;
}

export function isKeyspaceBrowser(driver: DatabaseDriver): driver is DatabaseDriver & KeyspaceBrowser {
	return typeof (driver as Partial<KeyspaceBrowser>).browseKeyspace === "function";
}
```

In `src/db/registry/connection-record.ts` line 3:

```ts
export const databaseEngineSchema = z.enum(["postgres", "mysql", "sqlite", "redis"]);
```

In `src/core/api-contract.ts` line 543:

```ts
export const runtimeDbEngineSchema = z.enum(["postgres", "mysql", "sqlite", "redis"]);
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run test/runtime/db/connection-store.test.ts test/runtime/db/driver-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (only if commits authorized)

```bash
git add src/db/types.ts src/db/driver/driver.ts src/db/registry/connection-record.ts src/core/api-contract.ts test/runtime/db/
git commit -m "feat(db): add redis engine to contract + KeyspaceBrowser capability"
```

---

### Task 2: Read-only command allowlist + command-line parser

**Files:**
- Create: `src/db/driver/redis/redis-commands.ts`
- Test: `test/runtime/db/redis-commands.test.ts`

**Interfaces:**
- Produces: `parseRedisCommandLine(line: string): { command: string; args: string[] }` (command uppercased; throws `MultiStatementError`-free — a single command line only; empty → throws `DbQueryError`). `isReadOnlyRedisCommand(command: string): boolean`. `READ_ONLY_REDIS_COMMANDS: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/db/redis-commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DbQueryError } from "../../../src/db/errors";
import { isReadOnlyRedisCommand, parseRedisCommandLine } from "../../../src/db/driver/redis/redis-commands";

describe("parseRedisCommandLine", () => {
	it("splits command and args, uppercasing the command", () => {
		expect(parseRedisCommandLine("hgetall user:1")).toEqual({ command: "HGETALL", args: ["user:1"] });
	});
	it("respects double-quoted args with spaces", () => {
		expect(parseRedisCommandLine('GET "a b"')).toEqual({ command: "GET", args: ["a b"] });
	});
	it("throws on an empty line", () => {
		expect(() => parseRedisCommandLine("   ")).toThrow(DbQueryError);
	});
});

describe("isReadOnlyRedisCommand", () => {
	it("allows GET and HGETALL (case-insensitive)", () => {
		expect(isReadOnlyRedisCommand("get")).toBe(true);
		expect(isReadOnlyRedisCommand("HGETALL")).toBe(true);
	});
	it("rejects writes and admin", () => {
		expect(isReadOnlyRedisCommand("SET")).toBe(false);
		expect(isReadOnlyRedisCommand("DEL")).toBe(false);
		expect(isReadOnlyRedisCommand("FLUSHALL")).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run test/runtime/db/redis-commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/db/driver/redis/redis-commands.ts`:

```ts
import { DbQueryError } from "../../errors";

/** Read-only Redis commands the policy + driver allow. Everything else is refused (fail closed). */
export const READ_ONLY_REDIS_COMMANDS: ReadonlySet<string> = new Set([
	"GET", "GETRANGE", "STRLEN", "SUBSTR", "MGET", "EXISTS", "TYPE", "TTL", "PTTL",
	"EXPIRETIME", "PEXPIRETIME", "OBJECT", "DUMP",
	"HGET", "HGETALL", "HMGET", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSCAN", "HSTRLEN", "HRANDFIELD",
	"LRANGE", "LLEN", "LINDEX", "LPOS",
	"SMEMBERS", "SISMEMBER", "SMISMEMBER", "SCARD", "SSCAN", "SRANDMEMBER", "SINTERCARD",
	"ZRANGE", "ZRANGEBYSCORE", "ZRANGEBYLEX", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZCARD", "ZCOUNT",
	"ZSCORE", "ZMSCORE", "ZRANK", "ZREVRANK", "ZSCAN", "ZLEXCOUNT",
	"SCAN", "KEYS", "DBSIZE", "RANDOMKEY", "MEMORY",
	"XLEN", "XRANGE", "XREVRANGE", "XINFO",
	"PING", "INFO",
	"GEOPOS", "GEODIST", "GEOSEARCH", "BITCOUNT", "GETBIT",
]);

export function isReadOnlyRedisCommand(command: string): boolean {
	return READ_ONLY_REDIS_COMMANDS.has(command.trim().toUpperCase());
}

/**
 * Parse one Redis command line into `{ command, args }`. Supports bare tokens and
 * double-quoted tokens (so a key/value containing spaces can be passed). Throws
 * {@link DbQueryError} on an empty line. Not a full RESP parser — good enough for the
 * read-only command surface a human types.
 */
export function parseRedisCommandLine(line: string): { command: string; args: string[] } {
	const tokens: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(line)) !== null) {
		tokens.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]);
	}
	if (tokens.length === 0) {
		throw new DbQueryError("empty redis command");
	}
	const [command, ...args] = tokens;
	return { command: command.toUpperCase(), args };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run test/runtime/db/redis-commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (if authorized)

```bash
git add src/db/driver/redis/redis-commands.ts test/runtime/db/redis-commands.test.ts
git commit -m "feat(db): redis read-only command allowlist + parser"
```

---

### Task 3: Redis reply shaper

**Files:**
- Create: `src/db/driver/redis/redis-reply-shaper.ts`
- Test: `test/runtime/db/redis-reply-shaper.test.ts`

**Interfaces:**
- Consumes: `FieldInfo`, `QueryResult` shape from `src/db/types`.
- Produces: `shapeRedisReply(command: string, reply: unknown): { rows: Array<Record<string, unknown>>; fields: FieldInfo[] }`.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/db/redis-reply-shaper.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shapeRedisReply } from "../../../src/db/driver/redis/redis-reply-shaper";

describe("shapeRedisReply", () => {
	it("scalar → one {value} row", () => {
		const r = shapeRedisReply("GET", "hello");
		expect(r.rows).toEqual([{ value: "hello" }]);
		expect(r.fields.map((f) => f.name)).toEqual(["value"]);
	});
	it("null → zero rows", () => {
		expect(shapeRedisReply("GET", null).rows).toEqual([]);
	});
	it("flat array → {index,value} rows", () => {
		const r = shapeRedisReply("SMEMBERS", ["a", "b"]);
		expect(r.rows).toEqual([{ index: 0, value: "a" }, { index: 1, value: "b" }]);
	});
	it("HGETALL object → {field,value} rows", () => {
		const r = shapeRedisReply("HGETALL", { name: "n", age: "3" });
		expect(r.rows).toEqual([{ field: "name", value: "n" }, { field: "age", value: "3" }]);
	});
	it("HGETALL RESP2 flat pair array → {field,value} rows", () => {
		const r = shapeRedisReply("HGETALL", ["name", "n", "age", "3"]);
		expect(r.rows).toEqual([{ field: "name", value: "n" }, { field: "age", value: "3" }]);
	});
	it("ZRANGE WITHSCORES pair array → {member,score} rows", () => {
		const r = shapeRedisReply("ZRANGE", ["m1", "1", "m2", "2"]);
		expect(r.rows).toEqual([{ member: "m1", score: "1" }, { member: "m2", score: "2" }]);
	});
	it("nested array element is JSON-stringified", () => {
		const r = shapeRedisReply("SCAN", [["a", "b"]]);
		expect(r.rows).toEqual([{ index: 0, value: '["a","b"]' }]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run test/runtime/db/redis-reply-shaper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/db/driver/redis/redis-reply-shaper.ts`:

```ts
import type { FieldInfo } from "../../types";

/** Commands whose flat/paired reply is (field, value). */
const HASH_PAIR_COMMANDS = new Set(["HGETALL"]);
/** Commands whose flat/paired reply is (member, score) when WITHSCORES was requested. */
const MEMBER_SCORE_COMMANDS = new Set(["ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZPOPMIN", "ZPOPMAX"]);

function fields(names: string[]): FieldInfo[] {
	return names.map((name) => ({ name }));
}

function cell(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	return JSON.stringify(value);
}

function isEvenPairArray(reply: unknown[]): boolean {
	return reply.length % 2 === 0 && reply.every((v) => typeof v === "string" || typeof v === "number");
}

/**
 * Normalize a heterogeneous Redis reply into rows/fields for the table view, keyed on the
 * command where a paired reply is meaningful (HGETALL fields, ZRANGE WITHSCORES scores) and
 * falling back to a generic scalar/array/object shape otherwise.
 */
export function shapeRedisReply(
	command: string,
	reply: unknown,
): { rows: Array<Record<string, unknown>>; fields: FieldInfo[] } {
	const cmd = command.toUpperCase();

	if (reply === null || reply === undefined) {
		return { rows: [], fields: fields(["value"]) };
	}

	// Object map (RESP3 HGETALL, XINFO, etc.) → field/value rows.
	if (typeof reply === "object" && !Array.isArray(reply)) {
		const rows = Object.entries(reply as Record<string, unknown>).map(([field, value]) => ({
			field,
			value: cell(value),
		}));
		return { rows, fields: fields(["field", "value"]) };
	}

	if (Array.isArray(reply)) {
		if (HASH_PAIR_COMMANDS.has(cmd) && isEvenPairArray(reply)) {
			const rows: Array<Record<string, unknown>> = [];
			for (let i = 0; i < reply.length; i += 2) {
				rows.push({ field: cell(reply[i]), value: cell(reply[i + 1]) });
			}
			return { rows, fields: fields(["field", "value"]) };
		}
		if (MEMBER_SCORE_COMMANDS.has(cmd) && isEvenPairArray(reply) && reply.length >= 2) {
			const rows: Array<Record<string, unknown>> = [];
			for (let i = 0; i < reply.length; i += 2) {
				rows.push({ member: cell(reply[i]), score: cell(reply[i + 1]) });
			}
			return { rows, fields: fields(["member", "score"]) };
		}
		const rows = reply.map((value, index) => ({ index, value: cell(value) }));
		return { rows, fields: fields(["index", "value"]) };
	}

	// Scalar.
	return { rows: [{ value: cell(reply) }], fields: fields(["value"]) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run test/runtime/db/redis-reply-shaper.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (if authorized)

```bash
git add src/db/driver/redis/redis-reply-shaper.ts test/runtime/db/redis-reply-shaper.test.ts
git commit -m "feat(db): redis reply → rows shaper"
```

---

### Task 4: Connection URL + client seam

**Files:**
- Create: `src/db/driver/redis/redis-client.ts`
- Test: `test/runtime/db/redis-client.test.ts`

**Interfaces:**
- Consumes: `ConnectionConfig` from `src/db/types`.
- Produces: `interface RedisClientLike { connected: boolean; connect(): Promise<void>; close(): void; send(command: string, args: string[]): Promise<unknown>; }`; `type RedisClientFactory = (url: string, options?: RedisClientOptions) => RedisClientLike`; `buildRedisUrl(config: ConnectionConfig): string`; `buildRedisTlsOptions(config): RedisClientOptions | undefined`; `defaultRedisClientFactory: RedisClientFactory`; `type RedisClientOptions` (subset of Bun `RedisOptions` this driver sets: `{ tls?: boolean | { rejectUnauthorized?: boolean; ca?: string; key?: string; cert?: string } }`).

- [ ] **Step 1: Write the failing test**

Create `test/runtime/db/redis-client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRedisUrl } from "../../../src/db/driver/redis/redis-client";
import type { ConnectionConfig } from "../../../src/db/types";

const base: ConnectionConfig = { engine: "redis", host: "localhost", port: 6379 };

describe("buildRedisUrl", () => {
	it("builds a plain redis:// url with db index", () => {
		expect(buildRedisUrl({ ...base, database: "2" })).toBe("redis://localhost:6379/2");
	});
	it("defaults db to 0 and port to 6379", () => {
		expect(buildRedisUrl({ engine: "redis", host: "h" })).toBe("redis://h:6379/0");
	});
	it("uses rediss:// when ssl mode is not disable", () => {
		expect(buildRedisUrl({ ...base, ssl: { mode: "require" } })).toBe("rediss://localhost:6379/0");
	});
	it("embeds user:password credentials, url-encoded", () => {
		expect(buildRedisUrl({ ...base, user: "u", password: "p@ss word" })).toBe(
			"redis://u:p%40ss%20word@localhost:6379/0",
		);
	});
	it("uses a unix socket url when filePath is set", () => {
		expect(buildRedisUrl({ engine: "redis", filePath: "/var/run/redis.sock" })).toBe(
			"redis+unix:///var/run/redis.sock",
		);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run test/runtime/db/redis-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/db/driver/redis/redis-client.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run test/runtime/db/redis-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the lazy-Bun reference**

Run: `bun run typecheck` (or the repo's runtime `tsc`); confirm `Bun.RedisClient` resolves against `bun-types`. If `Bun.RedisClient` is not on the global type, use `new (Bun as unknown as { RedisClient: new (u: string, o?: unknown) => RedisClientLike }).RedisClient(url, options)`.
Expected: no new type errors.

- [ ] **Step 6: Commit** (if authorized)

```bash
git add src/db/driver/redis/redis-client.ts test/runtime/db/redis-client.test.ts
git commit -m "feat(db): redis connection url + client factory seam"
```

---

### Task 5: RedisDriver + registration

**Files:**
- Create: `src/db/driver/redis/redis-driver.ts`
- Create: `src/db/driver/redis/register.ts`
- Modify: `src/db/index.ts:1-4` (add `import "./driver/redis/register";`) and re-export block (export driver types)
- Test: `test/runtime/db/redis-driver.test.ts`

**Interfaces:**
- Consumes: `DatabaseDriver`, `KeyspaceBrowser`, `BrowseKeyspaceInput/Result`, `RedisKeyspaceRow` (Task 1); `RedisClientLike`, `RedisClientFactory`, `buildRedisUrl`, `buildRedisTlsOptions`, `defaultRedisClientFactory` (Task 4); `parseRedisCommandLine`, `isReadOnlyRedisCommand` (Task 2); `shapeRedisReply` (Task 3).
- Produces: `class RedisDriver implements DatabaseDriver, KeyspaceBrowser` with constructor `(config: ConnectionConfig, factory?: RedisClientFactory)`. Registered as `registerDriver("redis", (config) => new RedisDriver(config))`.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/db/redis-driver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DbPolicyError } from "../../../src/db/errors";
import { RedisDriver } from "../../../src/db/driver/redis/redis-driver";
import type { RedisClientLike } from "../../../src/db/driver/redis/redis-client";
import type { ConnectionConfig } from "../../../src/db/types";

/** A fake RedisClient driven by a per-command handler; records every send. */
function fakeClient(handler: (command: string, args: string[]) => unknown): {
	client: RedisClientLike;
	calls: Array<{ command: string; args: string[] }>;
} {
	const calls: Array<{ command: string; args: string[] }> = [];
	const client: RedisClientLike = {
		connected: true,
		connect: async () => {},
		close: () => {},
		send: async (command, args) => {
			calls.push({ command, args });
			return handler(command, args);
		},
	};
	return { client, calls };
}

const config: ConnectionConfig = { engine: "redis", host: "h", port: 6379, database: "0" };

function driver(client: RedisClientLike): RedisDriver {
	return new RedisDriver(config, () => client);
}

describe("RedisDriver", () => {
	it("testConnection returns the redis_version from INFO", async () => {
		const { client } = fakeClient((cmd) => {
			if (cmd === "PING") return "PONG";
			if (cmd === "INFO") return "# Server\r\nredis_version:7.2.4\r\n";
			return null;
		});
		const d = driver(client);
		await d.connect();
		const r = await d.testConnection();
		expect(r.ok).toBe(true);
		expect(r.serverVersion).toBe("7.2.4");
	});

	it("query runs an allowlisted command and shapes the reply", async () => {
		const { client, calls } = fakeClient((cmd) => (cmd === "HGETALL" ? { a: "1" } : null));
		const d = driver(client);
		await d.connect();
		const r = await d.query({ sql: "HGETALL user:1", readOnly: true });
		expect(r.rows).toEqual([{ field: "a", value: "1" }]);
		expect(calls.some((c) => c.command === "HGETALL")).toBe(true);
	});

	it("query refuses a non-allowlisted command", async () => {
		const { client } = fakeClient(() => null);
		const d = driver(client);
		await d.connect();
		await expect(d.query({ sql: "SET k v", readOnly: true })).rejects.toBeInstanceOf(DbPolicyError);
	});

	it("listTables groups keys by prefix (bounded SCAN sweep)", async () => {
		const { client } = fakeClient((cmd, args) => {
			if (cmd === "SELECT") return "OK";
			if (cmd === "SCAN") return ["0", ["user:1", "user:2", "session:x", "barekey"]];
			return null;
		});
		const d = driver(client);
		await d.connect();
		const tables = await d.listTables("db0");
		expect(tables.map((t) => t.name).sort()).toEqual(["(root)", "session", "user"]);
		expect(tables.every((t) => t.kind === "table")).toBe(true);
	});

	it("describeTable returns the fixed key/type/ttl/value columns with key as PK", async () => {
		const { client } = fakeClient(() => null);
		const d = driver(client);
		await d.connect();
		const detail = await d.describeTable("db0", "user");
		expect(detail.columns.map((c) => c.name)).toEqual(["key", "type", "ttl", "value"]);
		expect(detail.columns.find((c) => c.name === "key")?.isPrimaryKey).toBe(true);
	});

	it("browseKeyspace scans a prefix and enriches each key with type/ttl/value", async () => {
		const { client } = fakeClient((cmd, args) => {
			if (cmd === "SELECT") return "OK";
			if (cmd === "SCAN") return ["7", ["user:1"]];
			if (cmd === "TYPE") return "string";
			if (cmd === "TTL") return -1;
			if (cmd === "GET") return "alice";
			return null;
		});
		const d = driver(client);
		await d.connect();
		const r = await d.browseKeyspace({ schema: "db0", prefix: "user", cursor: null, limit: 100, valuePreviewLimit: 20 });
		expect(r.rows).toEqual([{ key: "user:1", type: "string", ttl: -1, value: "alice" }]);
		expect(r.scanCursor).toBe("7");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run test/runtime/db/redis-driver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the driver**

Create `src/db/driver/redis/redis-driver.ts`:

```ts
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
					const raw = asString(await this.send("GETRANGE", [key, "0", String(limit)]));
					return raw;
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
```

Create `src/db/driver/redis/register.ts`:

```ts
// Importing this module registers the Redis driver as a side effect.
import "./redis-driver";
```

- [ ] **Step 4: Wire the registration into the index**

In `src/db/index.ts`, after line 4 (`import "./driver/sqlite-driver";`):

```ts
import "./driver/redis/register";
```

And add to the driver re-export (after the `DatabaseDriver` export on line 14):

```ts
export {
	type BrowseKeyspaceInput,
	type BrowseKeyspaceResult,
	isKeyspaceBrowser,
	type KeyspaceBrowser,
	type RedisKeyspaceRow,
} from "./driver/driver";
```

- [ ] **Step 5: Run to verify it passes**

Run: `bunx vitest run test/runtime/db/redis-driver.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 6: Verify the engine is registered**

Add to `test/runtime/db/driver-registry.test.ts`:

```ts
it("creates a redis driver via the registry", async () => {
	const { createDriver } = await import("../../../src/db/driver/driver-registry");
	await import("../../../src/db/driver/redis/register");
	const d = createDriver({ engine: "redis", host: "h" });
	expect(d.engine).toBe("redis");
});
```

Run: `bunx vitest run test/runtime/db/driver-registry.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit** (if authorized)

```bash
git add src/db/driver/redis/ src/db/index.ts test/runtime/db/redis-driver.test.ts test/runtime/db/driver-registry.test.ts
git commit -m "feat(db): RedisDriver on Bun.redis (send-only, prefix tables, keyspace browse)"
```

---

### Task 6: Classifier + bounds redis branches

**Files:**
- Modify: `src/db/policy/sql-classifier.ts`
- Modify: `src/db/execution/query-bounds.ts:104-116`
- Test: `test/runtime/db/sql-classifier.test.ts` (extend), `test/runtime/db/query-bounds.test.ts` (extend)

**Interfaces:**
- Consumes: `classifySql(sql, engine)` (existing), `isReadOnlyRedisCommand`, `parseRedisCommandLine` (Task 2).
- Produces: `classifySql` returns `"read"` for an allowlisted redis command, `"write"` otherwise; `buildBoundedQuery` returns `wrapped:false` for redis (never wraps).

Note: `classifySql`'s signature does not take an engine-independent flag; the redis branch keys off `engine === "redis"`. `buildBoundedQuery` currently takes only `{ sql, classification, page }` — add an optional `engine?` field so the redis branch can skip wrapping even when classified `read`. Update the two call sites in `query-executor.ts` (`runBounded`) to pass `engine: record.engine`.

- [ ] **Step 1: Write the failing tests**

Add to `test/runtime/db/sql-classifier.test.ts`:

```ts
it("classifies an allowlisted redis command as read", () => {
	expect(classifySql("HGETALL user:1", "redis")).toBe("read");
	expect(classifySql("scan 0", "redis")).toBe("read");
});
it("classifies a redis write command as write", () => {
	expect(classifySql("SET k v", "redis")).toBe("write");
	expect(classifySql("FLUSHALL", "redis")).toBe("write");
});
```

Add to `test/runtime/db/query-bounds.test.ts`:

```ts
it("never wraps a redis read (self-bounded by SCAN/range)", () => {
	const r = buildBoundedQuery({ sql: "SCAN 0", classification: "read", engine: "redis", page: { pageSize: 10 } });
	expect(r.wrapped).toBe(false);
	expect(r.sql).toBe("SCAN 0");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run test/runtime/db/sql-classifier.test.ts test/runtime/db/query-bounds.test.ts`
Expected: FAIL — redis classified `unknown`; redis read gets wrapped.

- [ ] **Step 3: Implement the classifier branch**

In `src/db/policy/sql-classifier.ts`, add imports at top:

```ts
import { isReadOnlyRedisCommand, parseRedisCommandLine } from "../driver/redis/redis-commands";
```

At the very start of `classifySql`, before the node-sql-parser path:

```ts
	if (engine === "redis") {
		try {
			const { command } = parseRedisCommandLine(sql);
			return isReadOnlyRedisCommand(command) ? "read" : "write";
		} catch {
			return "unknown";
		}
	}
```

ALSO fix the now-incomplete `PARSER_DIALECT` map. Task 1 widened `DatabaseEngine` to include `"redis"`, so `const PARSER_DIALECT: Record<DatabaseEngine, string>` (currently `{ postgres, mysql, sqlite }`) fails to typecheck (`TS2741: Property 'redis' is missing`). Redis returns early above and never indexes this map, so exclude it from the map's type rather than adding a bogus dialect. Change the declaration:

```ts
/** node-sql-parser dialect key per SQL engine (redis is handled before this map is read). */
const PARSER_DIALECT: Record<Exclude<DatabaseEngine, "redis">, string> = {
	postgres: "postgresql",
	mysql: "mysql",
	sqlite: "sqlite",
};
```

Because the redis early-return runs first, `PARSER_DIALECT[engine]` below is only reached for non-redis engines; if TypeScript still narrows `engine` to include `"redis"` at the index site, index with `PARSER_DIALECT[engine as Exclude<DatabaseEngine, "redis">]`.

Verify with `bun run typecheck` that `src/db/policy/sql-classifier.ts` reports NO errors (the repo has unrelated pre-existing baseline errors in other files — those are not yours; only confirm no `sql-classifier.ts` error remains).

- [ ] **Step 4: Implement the bounds branch**

In `src/db/execution/query-bounds.ts`, extend `BuildBoundedQueryInput`:

```ts
export interface BuildBoundedQueryInput {
	sql: string;
	classification: SqlClassification;
	page: PageRequest;
	/** Engine hint; a KV engine (redis) is self-bounded and never LIMIT-wrapped. */
	engine?: string;
}
```

At the top of `buildBoundedQuery`, before the `classification !== "read"` check:

```ts
	if (input.engine === "redis") {
		return { sql: input.sql, wrapped: false, fetchLimit: 0, offset: 0 };
	}
```

In `src/db/execution/query-executor.ts` `runBounded` (around line 213), pass the engine:

```ts
		const bounded = buildBoundedQuery({
			sql: input.sql,
			classification,
			engine: record.engine,
			page: { pageSize, cursor: input.page?.cursor },
		});
```

- [ ] **Step 5: Run to verify they pass**

Run: `bunx vitest run test/runtime/db/sql-classifier.test.ts test/runtime/db/query-bounds.test.ts test/runtime/db/query-executor.test.ts`
Expected: PASS (existing executor tests still green).

- [ ] **Step 6: Commit** (if authorized)

```bash
git add src/db/policy/sql-classifier.ts src/db/execution/query-bounds.ts src/db/execution/query-executor.ts test/runtime/db/sql-classifier.test.ts test/runtime/db/query-bounds.test.ts
git commit -m "feat(db): classify redis commands + skip LIMIT wrap for redis"
```

---

### Task 7: Service `browseKeyspace` + executor `browseTable` dispatch

**Files:**
- Modify: `src/db/db-service.ts`
- Modify: `src/db/execution/query-executor.ts`
- Test: `test/runtime/db/db-service.test.ts` (extend), `test/runtime/db/query-executor.test.ts` (extend)

**Interfaces:**
- Consumes: `isKeyspaceBrowser`, `BrowseKeyspaceInput/Result` (Task 1); `RedisDriver.browseKeyspace` (Task 5).
- Produces: `DatabaseService.browseKeyspace(input: { connId; caller; schema; prefix; cursor; limit; valuePreviewLimit }): Promise<BrowseKeyspaceResult>`. `QueryExecutor.browseTable` dispatches to a redis keyspace path returning the same `ExecuteQueryResult`, with `nextCursor` derived from `scanCursor` (`"0"` ⇒ done).

- [ ] **Step 1: Write the failing test**

Add to `test/runtime/db/db-service.test.ts` a case where the fake driver implements `browseKeyspace`:

```ts
it("browseKeyspace delegates to a KeyspaceBrowser driver", async () => {
	const driver = {
		engine: "redis",
		connect: async () => {},
		disconnect: async () => {},
		browseKeyspace: async () => ({
			rows: [{ key: "user:1", type: "string", ttl: -1, value: "x" }],
			scanCursor: "0",
			durationMs: 1,
		}),
	} as never;
	const service = makeServiceWithDriver(driver); // reuse the file's existing driver-injection helper
	const r = await service.browseKeyspace({
		connId: "c", caller: "human", schema: "db0", prefix: "user", cursor: null, limit: 10, valuePreviewLimit: 20,
	});
	expect(r.rows[0].key).toBe("user:1");
	expect(r.scanCursor).toBe("0");
});
```

(If `db-service.test.ts` has no driver-injection helper, follow the pattern its other tests use to supply a fake `poolManager.getDriver`.)

Add to `test/runtime/db/query-executor.test.ts` a redis browse case (fake service exposing `browseKeyspace` + a redis `loadConnection`):

```ts
it("browseTable pages a redis keyspace via scanCursor", async () => {
	const service = {
		browseKeyspace: async () => ({
			rows: [{ key: "user:1", type: "string", ttl: -1, value: "x" }],
			scanCursor: "42",
			durationMs: 1,
		}),
		runQuery: async () => { throw new Error("should not be called for redis"); },
		invalidate: async () => {},
		describeTable: async () => { throw new Error("nope"); },
	} as never;
	const executor = new QueryExecutor({ service, loadConnection: async () => ({ engine: "redis", connId: "c" } as never) });
	const r = await executor.browseTable({ connId: "c", schema: "db0", table: "user", caller: "human" });
	expect(r.rows[0].key).toBe("user:1");
	expect(r.pagination.hasMore).toBe(true);
	expect(r.pagination.nextCursor).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run test/runtime/db/db-service.test.ts test/runtime/db/query-executor.test.ts`
Expected: FAIL — `browseKeyspace` not defined.

- [ ] **Step 3: Implement `DatabaseService.browseKeyspace`**

In `src/db/db-service.ts`, add the import and method. Import near the top:

```ts
import { isKeyspaceBrowser } from "./driver/driver";
import type { BrowseKeyspaceResult } from "./driver/driver";
import { DbConnectionError, UnsupportedEngineError } from "./errors";
```

(Merge with the existing `import { DbConnectionError } from "./errors";`.)

Add the method (after `describeTable`):

```ts
	/**
	 * Browse a Redis keyspace prefix page (SCAN + per-key TYPE/TTL/value preview). Always
	 * read-only. Throws {@link UnsupportedEngineError} if the driver is not a KeyspaceBrowser.
	 */
	async browseKeyspace(input: {
		connId: string;
		caller: DbCaller;
		schema: string;
		prefix: string;
		cursor: string | null;
		limit: number;
		valuePreviewLimit: number;
	}): Promise<BrowseKeyspaceResult> {
		const { record, driver } = await this.resolveDriver(input.connId);
		if (!isKeyspaceBrowser(driver)) {
			throw new UnsupportedEngineError(record.engine);
		}
		return driver.browseKeyspace({
			schema: input.schema,
			prefix: input.prefix,
			cursor: input.cursor,
			limit: input.limit,
			valuePreviewLimit: input.valuePreviewLimit,
		});
	}
```

- [ ] **Step 4: Implement executor dispatch**

In `src/db/execution/query-executor.ts`:

Extend the `QueryExecutorDeps.service` pick to include `browseKeyspace`:

```ts
	service: Pick<DatabaseService, "runQuery" | "invalidate" | "describeTable" | "browseKeyspace">;
```

Add these constants near `DEFAULT_QUERY_EXECUTION_LIMITS`:

```ts
/** Default per-value preview budget for a redis keyspace browse. */
const REDIS_VALUE_PREVIEW_LIMIT = 64;
```

In `browseTable`, dispatch before the SQL keyset path (i.e. change `runBrowse` entry). Simplest: at the top of `runBrowse`, after loading `record`:

```ts
		if (record.engine === "redis") {
			return this.runRedisBrowse(input, started, record.engine);
		}
```

Add the redis browse method:

```ts
	private async runRedisBrowse(
		input: BrowseTableInput,
		started: number,
		_engine: string,
	): Promise<ExecuteQueryResult> {
		const limits = { ...this.limits, ...input.limits };
		const pageSize = clampPageSize(input.page?.pageSize ?? limits.defaultPageSize, limits.maxRows);
		const cursor = decodeScanCursor(input.page?.cursor);
		const result = await this.deps.service.browseKeyspace({
			connId: input.connId,
			caller: input.caller,
			schema: input.schema,
			prefix: input.table,
			cursor,
			limit: pageSize,
			valuePreviewLimit: REDIS_VALUE_PREVIEW_LIMIT,
		});
		let rows: Array<Record<string, unknown>> = result.rows.map((r) => ({ ...r }));
		const capped = capRowsByBytes(rows, limits.maxBytes);
		rows = capped.rows;
		const done = result.scanCursor === "0";
		const hasMore = !done || capped.truncated;
		const nextCursor = hasMore ? encodeScanCursor(result.scanCursor) : null;
		return {
			columns: [
				{ name: "key" }, { name: "type" }, { name: "ttl" }, { name: "value" },
			],
			rows,
			rowCount: rows.length,
			affectedRows: null,
			classification: "read",
			readOnly: true,
			durationMs: result.durationMs,
			totalDurationMs: this.now() - started,
			pagination: { paginated: true, pageSize, hasMore, nextCursor },
			truncated: { byRows: false, byBytes: capped.truncated },
		};
	}
```

Add the cursor codec helpers at the bottom of the file (next to `clampPageSize`):

```ts
/** Encode a redis SCAN cursor into the opaque browse cursor token. */
function encodeScanCursor(scanCursor: string): string {
	return Buffer.from(JSON.stringify({ s: scanCursor }), "utf8").toString("base64url");
}

/** Decode the opaque browse cursor back to a redis SCAN cursor; absent ⇒ null (start). */
function decodeScanCursor(cursor: string | null | undefined): string | null {
	if (!cursor) {
		return null;
	}
	try {
		const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown };
		if (typeof decoded.s === "string") {
			return decoded.s;
		}
	} catch {
		// fall through
	}
	throw new InvalidCursorError();
}
```

Ensure `capRowsByBytes` is imported (it is already, via `./query-bounds`).

- [ ] **Step 5: Run to verify they pass**

Run: `bunx vitest run test/runtime/db/db-service.test.ts test/runtime/db/query-executor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit** (if authorized)

```bash
git add src/db/db-service.ts src/db/execution/query-executor.ts test/runtime/db/db-service.test.ts test/runtime/db/query-executor.test.ts
git commit -m "feat(db): service browseKeyspace + executor redis browse dispatch"
```

---

### Task 8: tRPC surfaces (CLI channel + human UI)

**Files:**
- Modify: `src/trpc/db-api.ts` (verify engine passthrough; browse already routes through executor)
- Modify: `src/trpc/workspace-db-api.ts:261-292` (`browseTable` redis branch) + `upsertConnection` force `allowWrites:false` for redis
- Test: `test/runtime/trpc/db-api.test.ts` (extend)

**Interfaces:**
- Consumes: `QueryExecutor.browseTable` redis dispatch (Task 7).
- Produces: `db.browse`/`db.query`/`db.tables`/`db.describe` work for a redis connection via CLI channel; human UI `browseTable` uses `executor.browseTable` (not `buildBrowseQuery`) for redis.

- [ ] **Step 1: Write the failing test**

Add to `test/runtime/trpc/db-api.test.ts` a redis case using an injected fake pool/driver (follow the file's existing dependency-injection pattern — `createDbApi({ poolManager, loadConnections, ... })`). Assert `browseTable` on a redis connection returns rows with `key/type/ttl/value` columns:

```ts
it("browses a redis connection's keyspace prefix", async () => {
	// Register the redis driver + inject a fake RedisClient via a poolManager whose getDriver
	// returns a RedisDriver constructed with a fake factory (see redis-driver.test.ts fakeClient).
	// ...arrange a connection record { engine: "redis", connId: "r" }...
	const res = await api.browseTable({ workspaceId: "w" }, { connId: "r", schema: "db0", table: "user" });
	expect(res.columns.map((c) => c.name)).toEqual(["key", "type", "ttl", "value"]);
});
```

(Use the same fake-driver injection the postgres/mysql db-api tests use; if the test file constructs a real `PoolManager`, provide a `poolManager` stub whose `getDriver` returns a `RedisDriver(config, () => fakeClient)`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run test/runtime/trpc/db-api.test.ts`
Expected: FAIL until the human UI branch + engine passthrough are correct (db-api browse already calls `executor.browseTable`, so this may pass for the CLI channel once Task 7 lands — if so, add the workspace-db-api assertion below instead).

- [ ] **Step 3: Human UI browse branch**

In `src/trpc/workspace-db-api.ts` `browseTable` (line ~261), branch on engine:

```ts
	async browseTable(scope, input) {
		const record = await loadRecordOrThrow(scope.workspaceId, input.connId);
		try {
			// Redis has no SQL browse — route through the executor's keyspace dispatch instead of buildBrowseQuery.
			if (record.engine === "redis") {
				const result = await getWorkspaceDbStack(scope.workspaceId).executor.browseTable({
					connId: input.connId,
					schema: input.schema,
					table: input.table,
					caller: CALLER,
					page: { pageSize: input.pageSize, cursor: input.cursor },
				});
				return {
					columns: result.columns.map((c) => ({ name: c.name, dataType: c.dataType ?? null })),
					rows: result.rows.map((row) => formatDbRow(row)),
					rowCount: result.rowCount,
					pagination: {
						pageSize: result.pagination.pageSize,
						hasMore: result.pagination.hasMore,
						nextCursor: result.pagination.nextCursor,
					},
					truncated: result.truncated,
				};
			}
			const built = buildBrowseQuery({
				engine: record.engine,
				schema: input.schema,
				table: input.table,
				filters: input.filters,
				sort: input.sort,
			});
			const result = await getWorkspaceDbStack(scope.workspaceId).executor.execute({
				connId: input.connId,
				sql: built.sql,
				params: built.params,
				caller: CALLER,
				page: { pageSize: input.pageSize, cursor: input.cursor },
			});
			return {
				columns: result.columns.map((c) => ({ name: c.name, dataType: c.dataType ?? null })),
				rows: result.rows.map((row) => formatDbRow(row)),
				rowCount: result.rowCount,
				pagination: {
					pageSize: result.pagination.pageSize,
					hasMore: result.pagination.hasMore,
					nextCursor: result.pagination.nextCursor,
				},
				truncated: result.truncated,
			};
		} catch (error) {
			throw toTrpcError(error);
		}
	},
```

- [ ] **Step 4: Force redis connections read-only on upsert**

In `src/trpc/workspace-db-api.ts` `upsertConnection`, when building `next`, force `allowWrites` false for redis:

```ts
					allowWrites: input.engine === "redis" ? false : input.allowWrites,
```

Apply the same guard in `src/trpc/db-api.ts` `addConnection` (line ~192):

```ts
					allowWrites: input.engine === "redis" ? false : (input.allowWrites ?? false),
```

- [ ] **Step 5: Run to verify it passes**

Run: `bunx vitest run test/runtime/trpc/db-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit** (if authorized)

```bash
git add src/trpc/workspace-db-api.ts src/trpc/db-api.ts test/runtime/trpc/db-api.test.ts
git commit -m "feat(db): wire redis browse through tRPC; force redis connections read-only"
```

---

### Task 9: CLI engine option

**Files:**
- Modify: `src/commands/db.ts:14` and the `--engine` help text (line ~300)
- Test: manual CLI smoke (no dedicated unit test — `parseEngine` is exercised by the value list)

**Interfaces:**
- Consumes: `RuntimeDbEngine` now includes `"redis"` (Task 1).
- Produces: `kanban db connection add --engine redis …` accepted; `db query "HGETALL user:1"` runs a Redis command.

- [ ] **Step 1: Update the engine list**

In `src/commands/db.ts` line 14:

```ts
const VALID_ENGINES: readonly RuntimeDbEngine[] = ["postgres", "mysql", "sqlite", "redis"];
```

Update the `--engine` option help text (around line 300) to include redis:

```ts
		.requiredOption("--engine <engine>", "Database engine: postgres | mysql | sqlite | redis.", parseEngine)
```

And the `db query` description (around line 497) to note redis takes a command line:

```ts
			"Run a read-only query. SQL engines: a single SELECT. Redis: a single read-only command " +
				"(e.g. \"HGETALL user:1\"). Writes/DDL are refused even on an allowWrites connection.",
```

- [ ] **Step 2: Verify the CLI parses redis**

Run: `bun src/cli.ts db connection add --help` and confirm the engine list shows redis.
Then (with a runtime + local Redis): `bun src/cli.ts db connection add --engine redis --host localhost --port 6379 --label "local redis" --json` → envelope `ok:true`.
Expected: accepted; connection listed with `engine:"redis"`.

- [ ] **Step 3: Commit** (if authorized)

```bash
git add src/commands/db.ts
git commit -m "feat(cli): accept redis engine in kanban db"
```

---

### Task 10: web-ui — connection dialog + sidebar

**Files:**
- Modify: `web-ui/src/components/database/connection-dialog.tsx:20-30` (labels/ports), field rendering, hide allow-writes for redis
- Modify: `web-ui/src/components/database/database-sidebar.tsx:12` (`ENGINE_TAG`)
- Test: `bun run web:typecheck` + manual UI smoke

**Interfaces:**
- Consumes: `RuntimeDbEngine` now includes `"redis"` (flows to web-ui via `@runtime-contract`).
- Produces: Add-connection dialog offers Redis; redis uses host/port/user/password/db + TLS; allow-writes hidden; sidebar shows a redis tag.

- [ ] **Step 1: Extend engine labels + default port**

In `connection-dialog.tsx`:

```ts
const ENGINE_LABELS: Record<RuntimeDbEngine, string> = {
	postgres: "PostgreSQL",
	mysql: "MySQL",
	sqlite: "SQLite",
	redis: "Redis",
};

const DEFAULT_PORT: Record<RuntimeDbEngine, number | null> = {
	postgres: 5432,
	mysql: 3306,
	sqlite: null,
	redis: 6379,
};
```

- [ ] **Step 2: Redis field rendering + hide allow-writes**

In `connection-dialog.tsx`, add a redis flag and reuse the non-sqlite host/port/user/password/SSL block (Redis uses the same fields; the `database` field doubles as the db index). Add near `isSqlite`:

```ts
	const isRedis = draft.engine === "redis";
```

Update `buildUpsertRequest` so redis never sends `allowWrites: true` and treats `database` as the db index string (already a string field — no change needed beyond forcing writes off):

```ts
		allowWrites: draft.engine === "redis" ? false : draft.allowWrites,
```

Relabel the `database` field for redis (optional nicety): in the Database `<label>`, show "Database (db index)" when `isRedis`. Wrap the allow-writes `<label>` block so it renders only when `!isRedis`:

```tsx
			{!isRedis && (
				<label htmlFor="db-conn-allow-writes" className="flex items-center gap-2 pt-1 cursor-pointer select-none">
					{/* …existing checkbox… */}
				</label>
			)}
			{!isRedis && (
				<p className="text-[11px] text-text-tertiary leading-relaxed">
					When off, this connection is read-only — browse only. The Kanban agent is always restricted to
					read-only regardless of this setting.
				</p>
			)}
			{isRedis && (
				<p className="text-[11px] text-text-tertiary leading-relaxed">
					Redis connections are always read-only (browse only). Only read commands are permitted.
				</p>
			)}
```

- [ ] **Step 3: Sidebar tag**

In `database-sidebar.tsx` line 12:

```ts
const ENGINE_TAG: Record<RuntimeDbEngine, string> = { postgres: "PG", mysql: "MY", sqlite: "SL", redis: "RD" };
```

- [ ] **Step 4: Typecheck**

Run: `bun run web:typecheck`
Expected: no errors (the `Record<RuntimeDbEngine, …>` maps now cover `redis`).

- [ ] **Step 5: Manual smoke**

Run the app; add a Redis connection to a local `redis-server`; confirm the left rail lists `db0`, expands to prefix "tables", and browsing a prefix shows `key/type/ttl/value` rows.

- [ ] **Step 6: Commit** (if authorized)

```bash
git add web-ui/src/components/database/connection-dialog.tsx web-ui/src/components/database/database-sidebar.tsx
git commit -m "feat(web-ui): Redis engine in the Database connection dialog + sidebar"
```

---

### Task 11: Real-connection bun test + docs

**Files:**
- Create: `test/bun/db/redis-driver.test.ts`
- Modify: `AGENTS.md` (add tribal-knowledge note)
- Modify: DB user/CLI docs under `.plan/docs/` (whichever documents the Database feature / `kanban db`)

**Interfaces:**
- Consumes: `RedisDriver` (Task 5).

- [ ] **Step 1: Write the gated real-connection test**

Create `test/bun/db/redis-driver.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { RedisDriver } from "../../../src/db/driver/redis/redis-driver";
import type { ConnectionConfig } from "../../../src/db/types";

const url = process.env.REDIS_TEST_URL;
const maybe = url ? describe : describe.skip;

maybe("RedisDriver (real connection)", () => {
	// Parse REDIS_TEST_URL into config, or pass host/port directly.
	const config: ConnectionConfig = { engine: "redis", host: "localhost", port: 6379, database: "0" };
	let driver: RedisDriver;

	beforeAll(async () => {
		driver = new RedisDriver(config);
		await driver.connect();
	});
	afterAll(async () => {
		await driver.disconnect();
	});

	it("pings and reports a version", async () => {
		const r = await driver.testConnection();
		expect(r.ok).toBe(true);
	});

	it("lists schemas (db0…)", async () => {
		const schemas = await driver.listSchemas();
		expect(schemas.some((s) => s.name === "db0")).toBe(true);
	});

	it("browses the keyspace", async () => {
		const r = await driver.browseKeyspace({ schema: "db0", prefix: "(root)", cursor: null, limit: 10, valuePreviewLimit: 32 });
		expect(Array.isArray(r.rows)).toBe(true);
	});

	it("refuses a write command", async () => {
		await expect(driver.query({ sql: "SET k v", readOnly: true })).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run the real test (optional, needs local Redis)**

Run: `REDIS_TEST_URL=redis://localhost:6379 bun test test/bun/db/redis-driver.test.ts`
Expected: PASS when a Redis server is up; the suite is `describe.skip` otherwise (so CI without Redis is green).

- [ ] **Step 3: Verify the whole vitest DB suite is green on Node**

Run: `npx vitest run test/runtime/db --exclude='**/.kanban/**'`
Expected: PASS — proves the redis modules import + run under Node with the injected fake and touch no `Bun` global.

- [ ] **Step 4: Add the AGENTS.md tribal-knowledge note**

Append a bullet to `AGENTS.md` (Misc. tribal knowledge), covering: redis engine is strictly read-only; the allowlist (`redis-commands.ts`) IS the enforcement (Redis has no SQL read-only session mode); the driver goes send-only so the test fake needs only `send`; `defaultRedisClientFactory` references `Bun` lazily so the module imports under Node; keyspace maps schema=`dbN` / table=key-prefix / columns=`key(PK)/type/ttl/value`; `QueryResult.scanCursor` + optional `KeyspaceBrowser` are the additive contract points; `SELECT` is issued per scoped read because it's connection-stateful; `listTables` sweeps a bounded SCAN (cap `LIST_TABLES_SCAN_CAP`, logs on truncation).

- [ ] **Step 5: Update DB docs**

Add a "Redis engine" subsection to the DB feature/CLI doc: connection URL forms (`redis://`, `rediss://`, `redis+unix://`), the read-only guarantee + allowlist, the KV→table mapping, and that `db query` takes a Redis command line for redis connections.

- [ ] **Step 6: Commit** (if authorized)

```bash
git add test/bun/db/redis-driver.test.ts AGENTS.md .plan/docs/
git commit -m "test(db): real-redis bun test (gated) + docs for the redis engine"
```

---

## Self-Review

**Spec coverage:**
- §2 mapping (schema/table/columns/browse/query/testConnection/metadataSignature) → Tasks 1,5.
- §2 adaptation points A–F → A/E/F Task 1; C Task 6; D Task 6; B Task 4; browse Task 7.
- §3 files + URL composition + send-only → Tasks 4,5.
- §4 read-only three layers → Task 2 (allowlist), Task 5 (driver guard), Task 8 (force allowWrites false); classifier Task 6; access gate unchanged (no task needed).
- §5 reply shaping + value preview → Tasks 3,5.
- §6 lifecycle/timeout/errors → Task 5 (connect/disconnect/errors); timeout via existing executor (Task 7 path).
- §7 three surfaces → tRPC Task 8, CLI Task 9, web-ui Task 10.
- §8 testing (pure/driver/executor/service/real) → Tasks 2,3,4,5,7,11.
- §9 docs → Task 11.
- §10 risks (scan cap, RESP2/3, SELECT, additive contract) → Task 5 (cap + shapeToPairs + selectDb), Task 1 (additive).

**Placeholder scan:** No TBD/TODO; each code step shows full code. The db-api/db-service test steps reference "the file's existing injection helper" — this is a directive to follow an established local pattern, not a placeholder; the assertions are concrete.

**Type consistency:** `browseKeyspace` signature identical across driver.ts (Task 1), redis-driver.ts (Task 5), db-service.ts (Task 7). `scanCursor` naming consistent. `RedisClientLike.send(command, args)` consistent across client (Task 4), driver (Task 5), fakes (Task 5). `BrowseKeyspaceResult { rows; scanCursor; durationMs }` consistent Tasks 1/5/7. `isReadOnlyRedisCommand`/`parseRedisCommandLine` consistent Tasks 2/5/6.

**Note on the `db-api` browse test (Task 8 Step 2):** since `db-api.browseTable` already calls `executor.browseTable`, the CLI channel may already pass once Task 7 lands; if so, keep the workspace-db-api assertion as the meaningful check and treat the db-api case as a regression guard.
