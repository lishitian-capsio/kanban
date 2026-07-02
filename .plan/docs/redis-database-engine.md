# Redis Database Engine

**Date:** 2026-07-02
**Status:** Implemented
**Scope:** Redis engine for the Kanban Database feature — `src/db/driver/redis/`.

## Overview

The Redis engine surfaces a Redis server as a read-only database in all three upper entries (web-UI, CLI, agent). It follows the same `DatabaseDriver` interface as the SQL engines, mapping Redis's KV model onto the schema/table/columns abstraction so the rest of the stack needs no Redis-specific logic.

## Connection URL forms

Connection config is stored as structured fields (host, port, user, password, ssl) in `ConnectionConfig` and assembled into a URL by `buildRedisUrl` at connect time:

| Form | When used |
|------|-----------|
| `redis://[user:password@]host:port/db` | Plain TCP (default) |
| `rediss://[user:password@]host:port/db` | TLS (`ssl.mode != "disable"`) |
| `redis+unix:///path/to/socket.sock` | Unix socket (`filePath` set in config) |

The `database` field in `ConnectionConfig` names the logical db index (e.g. `"0"`). TLS options (`rejectUnauthorized`, `ca`, `key`, `cert`) are derived from `DbSslConfig` by `buildRedisTlsOptions`.

## Strictly read-only guarantee

Redis has no SQL-style read-only session mode that covers arbitrary commands. The engine's read-only guarantee is enforced entirely by the **command allowlist** in `src/db/driver/redis/redis-commands.ts`:

- `READ_ONLY_REDIS_COMMANDS` is a `ReadonlySet<string>` of every command that only reads data (GET, SCAN, HGETALL, LRANGE, SMEMBERS, ZRANGE, INFO, TYPE, TTL, …).
- `isReadOnlyRedisCommand(command)` is checked by the driver's `query()` method before anything touches the wire. A command not in the set throws `DbPolicyError` immediately.
- `allowWrites` on a Redis connection record has no effect — the driver is unconditionally read-only; `allowWrites: false` is forced at the tRPC API layer when a connection is created or updated (`db-api.ts` `addConnection` and `workspace-db-api.ts` `upsertConnection` both set `allowWrites: input.engine === "redis" ? false : …`). `db-service.ts` reads the stored `record.allowWrites` as-is — the enforcement is at save time, not at query time.
- Real-connection bun tests (`test/bun/db/redis-driver.test.ts`, gated on `REDIS_TEST_URL`) verify that `SET k v` is rejected even when called via the standard `query()` path.

## KV → table mapping

The engine maps Redis's flat keyspace onto the schema/table/column model:

| DB concept | Redis mapping |
|-----------|---------------|
| **Schema** | Logical db: `db0`, `db1`, … `dbN`. Count queried from `CONFIG GET databases`. If CONFIG throws (disabled/denied — managed or cluster Redis), `listSchemas` returns a single `db0`. The 16-database default applies only when CONFIG succeeds but returns an unparseable reply. |
| **Table** | Key prefix — the segment of a key **before the first `:`**. Keys with no `:` delimiter are grouped under the synthetic table `(root)`. |
| **Columns** | Four fixed columns for every table: `key` (PK, string), `type` (string — Redis type: string/hash/list/set/zset/stream), `ttl` (integer — seconds remaining; -1 = no expiry, -2 = key missing), `value` (string — bounded preview rendered per type). |

`SELECT <n>` is issued before any scoped read (`listTables`, `browseKeyspace`) because Redis's `SELECT` command is connection-stateful — it re-targets the current connection to a specific logical db, not a per-query scope.

`listTables` sweeps the keyspace with a bounded SCAN (cap `LIST_TABLES_SCAN_CAP = 10,000` keys) to collect unique prefixes. If the cap is hit, a `warn` log is emitted and the prefix list may be incomplete.

## Browsing the keyspace

`browseKeyspace` (the `KeyspaceBrowser` interface in `src/db/driver/driver.ts`) pages through keys in a given schema/prefix using SCAN:

- `SCAN cursor MATCH prefix:* COUNT limit` materializes one page of keys.
- For the `(root)` table, `MATCH *` is used and keys containing `:` are filtered out post-scan.
- Each key is enriched with `TYPE`, `TTL`, and a bounded value preview fetched per Redis type (`GETRANGE`/`HGETALL`/`LRANGE`/`SSCAN`/`ZRANGE`/`XLEN` — all from the allowlist).
- `BrowseKeyspaceResult.scanCursor` carries the SCAN continuation cursor (`"0"` = scan complete). This is also surfaced in `QueryResult.scanCursor` for the general `query()` path.

## `db query` for Redis connections

For a redis connection, `db query <command-line>` takes a **Redis command line** rather than SQL. It is parsed by `parseRedisCommandLine` (quoted-token aware, handles `"key with spaces"`), checked against the allowlist, and sent to the server. The reply is shaped into `QueryResult` rows by `shapeRedisReply`.

Examples:
```
kanban db query "GET mykey" --connection my-redis
kanban db query "HGETALL user:42" --connection my-redis
kanban db query "LRANGE jobs 0 9" --connection my-redis
```

Write commands (`SET`, `DEL`, `LPUSH`, …) are rejected regardless of the connection's `allowWrites` setting.

## Implementation files

| File | Purpose |
|------|---------|
| `src/db/driver/redis/redis-driver.ts` | `RedisDriver` — implements `DatabaseDriver` + `KeyspaceBrowser` |
| `src/db/driver/redis/redis-client.ts` | `RedisClientLike` interface + `defaultRedisClientFactory` (lazy Bun global ref) + URL/TLS builders |
| `src/db/driver/redis/redis-commands.ts` | `READ_ONLY_REDIS_COMMANDS` allowlist + `isReadOnlyRedisCommand` + `parseRedisCommandLine` |
| `src/db/driver/redis/redis-reply-shaper.ts` | `shapeRedisReply` — maps raw RESP replies to `{ rows, fields }` |
| `src/db/driver/redis/register.ts` | Module side-effect: `registerDriver("redis", …)` |
| `test/runtime/db/redis-driver.test.ts` | Vitest unit tests with an injected fake client (no live Redis needed) |
| `test/runtime/db/redis-client.test.ts` | URL/TLS builder + `RedisClientLike` contract tests |
| `test/runtime/db/redis-commands.test.ts` | Allowlist + command-line parser tests |
| `test/runtime/db/redis-reply-shaper.test.ts` | Reply-shaping unit tests |
| `test/bun/db/redis-driver.test.ts` | Real-connection bun test (gated on `REDIS_TEST_URL`; skips in CI) |

## Testing

Vitest tests (Node, no live Redis) inject a `RedisClientLike` fake that only needs to implement `send(command, args)`. All policy, mapping, and reply-shaping logic is fully covered.

For a live end-to-end test:
```bash
REDIS_TEST_URL=redis://localhost:6379 bun test test/bun/db/redis-driver.test.ts
```

Without `REDIS_TEST_URL` the file skips all cases and reports 0 failures — safe for CI environments without Redis.
