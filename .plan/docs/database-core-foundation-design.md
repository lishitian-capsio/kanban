# Database Core Foundation — Design

**Date:** 2026-06-22
**Status:** Design (shared core only — no upper entry points)
**Scope:** `src/db/` shared core for the Kanban "Database" feature — a database client that will serve three upper entries (agent / human web-UI / CLI). This task builds **only** the shared foundation. No UI, MCP, or CLI surface is built here; those are separate downstream tasks (the "2/4/5/6" referenced in the brief) that all depend on this layer.

## Goal

Provide a reusable, engine-agnostic database access core with four cleanly separated concerns:

1. A **unified driver interface** with adapters for PostgreSQL, MySQL/MariaDB, and SQLite, built on mature third-party drivers (`pg`, `mysql2`, `better-sqlite3`).
2. A **workspace-level connection registry** that respects the project's two-root boundary: non-secret metadata travels with the repo; passwords/keys stay in machine-home (`~/.kanban`).
3. A **per-connection pool manager** that reuses connections and reclaims idle ones — never one-connection-per-query.
4. A **central security policy** (default read-only; write is connection-level opt-in; agent callers are capped read-only even when the connection allows writes) that is the single adjudication point shared by all three upper entries.

## Non-Goals

- No web-UI, MCP server, or CLI commands. (Downstream tasks.)
- No query history, saved queries, result pagination/streaming UX, or schema-diffing. (Downstream.)
- No migration tooling or write-builder. The core only *executes and adjudicates* SQL it is handed.
- No connection-string parsing UI. The registry stores structured fields; a connection-string helper can come later.

## Repository Conventions This Follows

- **Two-root split** (`src/state/workspace-state.ts` `BoardDataLocation`): committed data lives under `boardDataHome` (`<repo>/.kanban/workspaces/<id>/…`, travels with the repo / board branch); machine-local secrets live under machine-home (`~/.kanban/settings/…`). Verified precedent: `committed-provider-store.ts` (committed secret-free provider metadata sharded by id) + `agent-provider-config.ts` (secrets in `~/.kanban/settings/agent_providers.json` keyed by the same id).
- **Sharded JSON store** (`src/state/sharded-json-store.ts` `readShardDir`/`writeShardDir`): a directory mirrors a `Map<id, value>`; one file per id avoids cross-branch git merge conflicts. The connection registry uses this for committed metadata.
- **Locked read→mutate→write** owned by `workspace-state.ts` (`lockedFileSystem`, workspace-dir lock) — the registry's persistence seam lives there, like every other per-workspace store; the pure store logic lives in `src/db/`.
- **Logging facade** (`src/logging` `createLogger`): module-level `const log = createLogger("db:<area>")`; structured fields, no `console.*`.
- **TypeScript**: no `any`; prefer SDK-provided types from `pg` / `mysql2` / `better-sqlite3` / `node-sql-parser` over local redefinitions; standard top-level imports only.

## Module Layout (`src/db/`)

```
src/db/
  types.ts                 # Shared contract types: DatabaseEngine, ConnectionConfig,
                           # QueryResult, FieldInfo, SchemaIntrospection, DbCaller, etc.
  errors.ts                # Typed error classes (DbPolicyError, DbConnectionError,
                           # UnsupportedEngineError, MultiStatementError, ...)

  driver/
    driver.ts              # DatabaseDriver interface + DriverContext
    driver-registry.ts     # engine -> driver factory map (the extension point)
    postgres-driver.ts     # pg.Pool-backed adapter
    mysql-driver.ts        # mysql2/promise pool-backed adapter (also MariaDB)
    sqlite-driver.ts       # better-sqlite3 single-handle adapter

  pool/
    pool-manager.ts        # PoolManager: per-connId driver lifecycle + idle reclaim

  policy/
    sql-classifier.ts      # node-sql-parser based read/write/ddl classification
    access-policy.ts       # assertOperationAllowed(...) — the single adjudication point

  registry/
    connection-record.ts   # committed metadata schema + machine-home credential schema
    connection-store.ts    # pure read/assemble + write/decompose (sharded + secret file)

  db-service.ts            # Thin façade tying registry + pool + policy together for
                           # the three upper entries to consume (testConnection/run/introspect)
  index.ts                 # public barrel
```

### Why a `db-service.ts` façade
The three upper entries should not each re-wire "look up connection → resolve secret → get pool → adjudicate → run". `DatabaseService` exposes the small surface they share: `testConnection(connId)`, `runQuery({ connId, sql, caller })`, `introspect({ connId, caller })`. This guarantees the policy chokepoint cannot be bypassed by an entry author wiring a driver directly. (Per AGENTS.md "avoid thin shell wrappers" — this is *not* a pass-through: it owns secret resolution + policy adjudication + pool orchestration, real domain logic.)

## 1. Driver Interface + Adapters

```ts
export type DatabaseEngine = "postgres" | "mysql" | "sqlite";

export interface ConnectionConfig {
  engine: DatabaseEngine;
  // Network engines (postgres/mysql):
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  // SQLite:
  filePath?: string;
  // Transport security (non-secret bits live in metadata; key material is a secret):
  ssl?: DbSslConfig;
  // Resolved secret, injected at connect time — NEVER persisted in committed metadata:
  password?: string;
}

export interface QueryRequest {
  sql: string;
  params?: ReadonlyArray<unknown>;
  /** Adjudicated upstream; the driver trusts this and opens the matching session mode. */
  readOnly: boolean;
}

export interface FieldInfo { name: string; dataTypeId?: number; dataType?: string; }
export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  fields: FieldInfo[];
  rowCount: number;
  /** wall-clock ms for the execute call (telemetry / UX). */
  durationMs: number;
}

export interface ColumnInfo {
  name: string; dataType: string; nullable: boolean; isPrimaryKey: boolean; defaultValue: string | null;
}
export interface TableInfo { schema: string; name: string; kind: "table" | "view"; columns: ColumnInfo[]; }
export interface SchemaIntrospection { engine: DatabaseEngine; tables: TableInfo[]; }

export interface DatabaseDriver {
  readonly engine: DatabaseEngine;
  /** Lazily establish the underlying pool/handle. Idempotent. */
  connect(): Promise<void>;
  /** Tear down the pool/handle and free sockets/file handles. */
  disconnect(): Promise<void>;
  /** Cheap liveness check (SELECT 1 / PRAGMA). Returns latency + server version when available. */
  testConnection(): Promise<TestConnectionResult>;
  /** Execute one statement. `readOnly` selects the session mode (read-only txn / readonly handle). */
  query(request: QueryRequest): Promise<QueryResult>;
  /** Engine-specific catalog read, normalized to SchemaIntrospection. Always read-only. */
  introspect(): Promise<SchemaIntrospection>;
}
```

**Extensibility:** `driver-registry.ts` holds `Record<DatabaseEngine, (config, ctx) => DatabaseDriver>`. Adding ClickHouse/MSSQL later = add an engine literal + one factory entry; nothing else changes. An unknown engine throws `UnsupportedEngineError` (no silent fallback).

**Per-adapter notes:**
- **Postgres (`pg`):** wraps `pg.Pool`. `query({readOnly})` runs writes/reads as-is for read; for read-only it executes inside `BEGIN TRANSACTION READ ONLY; … ; COMMIT` (see §4 defense-in-depth). `introspect` queries `information_schema` + `pg_index` for PK flags. Reuses `pg`'s `FieldDef` for `fields`.
- **MySQL/MariaDB (`mysql2`):** wraps `mysql2/promise` `createPool`. Read-only uses `START TRANSACTION READ ONLY`. `introspect` via `information_schema.columns` + `key_column_usage`. Reuses `mysql2` `FieldPacket`.
- **SQLite (`better-sqlite3`):** synchronous, no native pool — wraps a single `Database` handle. Read-only opens the handle with `{ readonly: true }` (and a classifier guard still runs). The async `query` resolves synchronously-produced results. `introspect` via `sqlite_master` + `PRAGMA table_info`. Idle reclaim closes the handle.

## 2. Connection Registry

**Committed metadata** (sharded, secret-free) at
`<boardDataHome>/workspaces/<id>/db-connections/<connId>.json`:

```ts
const connectionRecordSchema = z.object({
  connId: z.string().min(1),          // also the shard filename + secret key
  label: z.string().min(1),
  engine: databaseEngineSchema,
  host: z.string().nullable(),
  port: z.number().int().positive().nullable(),
  database: z.string().nullable(),
  user: z.string().nullable(),
  filePath: z.string().nullable(),    // sqlite
  ssl: dbSslMetadataSchema.nullable(), // mode/CA-path level only — no key material
  /** Connection-level write opt-in. Default false => the whole connection is read-only. */
  allowWrites: z.boolean().default(false),
  createdAt: z.string(),              // ISO; passed in, never Date.now() in pure code
});
```

**Secrets** (machine-home, never committed) at `~/.kanban/settings/db-credentials.json`:

```ts
{ credentials: Record<connId, { password?: string; sslKeyPem?: string; sslCertPem?: string }> }
```

- `connection-store.ts` is **pure** (I/O injected): `readConnections(shardDir)` assembles `ConnectionRecord[]` from shards; `writeConnections(shardDir, map)` decomposes (deletes shards absent from the map, same as `writeShardDir`). A separate `readCredentials(path)` / `writeCredentials(path, data)` for the secret file (machine-home, no lock arg — mirrors `agent_providers.json`).
- `workspace-state.ts` gains the persistence seam (`loadWorkspaceDbConnections` / `mutateWorkspaceDbConnections`), resolving `repoPath` via the existing `resolveRepoPathForWorkspaceId`, holding the workspace-dir lock, exactly like the committed-provider seam. Path helpers: `getWorkspaceDbConnectionsShardDir` (under `boardDataHome`) and a machine-home `getDbCredentialsPath` (overridable via `KANBAN_DB_CREDENTIALS_PATH` for tests, mirroring `KANBAN_AGENT_PROVIDERS_PATH`).
- **Resolution at use time:** `db-service` joins the committed record + the machine-home secret into a full `ConnectionConfig` only in memory, only when opening a pool. A committed record never carries a secret; a missing secret is a normal state (e.g. fresh clone) surfaced as a typed "credential not configured" condition, not a crash.

`.kanban/.gitignore` is denylist-style, so the new `db-connections/` shard dir under the committed root is tracked by default; the machine-home credential file is outside the repo entirely. No gitignore change needed (verified same as `tasks/`, `agent-providers/`).

## 3. Connection Pool Manager

`PoolManager` is a process-level singleton keyed by `connId`:

- `getDriver(connId, configResolver): Promise<DatabaseDriver>` — returns the live driver for a connection, creating + `connect()`-ing it on first use, reusing it after. Concurrent first-use calls are de-duped (single in-flight `connect()` promise per id), like the journal/registry patterns already in the repo.
- **Idle reclaim:** each entry tracks `lastUsedAt`; a single shared timer (or per-entry timeout reset on use) calls `disconnect()` and evicts entries idle past `idleTimeoutMs` (default e.g. 5 min, configurable). Native pools (`pg`, `mysql2`) also have their own per-socket idle settings, configured conservatively; the manager governs the *driver* lifetime.
- **Invalidation:** when a connection record is edited or deleted (registry mutation), the manager evicts + `disconnect()`s any live driver for that `connId` so the next query rebuilds with fresh config. (`db-service` calls `poolManager.invalidate(connId)` after a registry mutation.)
- **Shutdown:** `disposeAll()` disconnects every driver; wired into the runtime shutdown path alongside existing disposers.

Pure pieces (idle-eviction decision, `lastUsedAt` bookkeeping) are separated so they're unit-testable without real sockets; timestamps are injected (no `Date.now()` inside pure functions, consistent with the workflow/test conventions).

## 4. Security Policy — the central adjudicator

This is the load-bearing layer; the other three (downstream 2/4/5/6) build on it.

**`DbCaller`:** `"agent" | "human" | "cli"`. (Extensible union.)

**`assertOperationAllowed(input): ResolvedOperation`** in `access-policy.ts` is the single chokepoint:

```ts
interface AccessPolicyInput {
  sql: string;
  caller: DbCaller;
  connectionAllowsWrites: boolean; // from the connection record
}
interface ResolvedOperation {
  classification: SqlClassification; // "read" | "write" | "ddl" | "unknown"
  readOnly: boolean;                 // the mode the driver must open
}
```

Decision table (defense-in-depth — **both** guards, per approved decision):

1. **Classify** the SQL via `sql-classifier.ts` (node-sql-parser AST; reject multi-statement → `MultiStatementError`; map statement type → `read | write | ddl`; an unparseable statement is `unknown` and treated as **write** — fail closed).
2. **Effective write permission** = `connectionAllowsWrites && caller !== "agent"`. Agent is *always* downgraded to read-only regardless of the connection flag (the brief's "agent default still read-only even if the connection opened writes").
3. If classification is `read` → allow, `readOnly: true`.
4. If classification is `write`/`ddl`/`unknown` and effective write permission is **false** → throw `DbPolicyError` with a precise reason (`"connection is read-only"` vs `"agent caller is restricted to read-only"`).
5. If allowed write → `readOnly: false`.
6. The resolved `readOnly` is passed to `driver.query`, which **also** opens the matching DB-level session mode (Postgres `BEGIN READ ONLY`, MySQL `START TRANSACTION READ ONLY`, SQLite readonly handle). So a classifier miss still cannot mutate — the database itself refuses the write.

`introspect` bypasses the classifier (it's driver-internal catalog SQL) but is **always** `readOnly: true`.

`access-policy.ts` and `sql-classifier.ts` are **pure** and the primary unit-test target: a table of SQL inputs × caller × `allowWrites` → expected allow/deny + `readOnly`, including the adversarial cases node-sql-parser is chosen for (`WITH x AS (...) DELETE ...`, leading comments, `SELECT ... INTO`, stacked statements, `EXPLAIN ANALYZE` of a write).

## Error Model (`errors.ts`)

Typed classes so upper layers can branch without string-matching: `DbPolicyError`, `MultiStatementError`, `DbConnectionError`, `CredentialNotConfiguredError`, `UnsupportedEngineError`, `DbQueryError` (wraps the driver's native error with engine + sanitized message — never echoes the secret/connection string).

## Testing Strategy

- **Pure, no DB needed (primary coverage):** `sql-classifier` + `access-policy` decision tables; `connection-store` read/assemble/decompose round-trips (temp dirs); `pool-manager` idle-eviction + de-dup logic with a fake driver + injected clock.
- **Driver smoke (opt-in / gated):** SQLite via `better-sqlite3` against a temp `:memory:`/file DB is cheap and hermetic → real test. Postgres/MySQL adapters get an interface-conformance test against a fake/mocked client plus, where a local server is available, a gated integration test (skipped by default, like the proxy-live pattern). No CI dependence on external DB servers.
- Run with `--exclude='**/.kanban/**'` to avoid sibling-worktree test capture (known repo gotcha).

## Dependencies to Add

- `pg` (+ `@types/pg` if not bundled), `mysql2`, `better-sqlite3` (+ `@types/better-sqlite3`), `node-sql-parser`.
- `better-sqlite3` is native (prebuilt binaries exist); confirm it builds in the dev/runtime environment during implementation. If it proves problematic in the target runtime, the driver-registry design lets the sqlite adapter be swapped (e.g. `node:sqlite`) without touching callers — noted as an implementation risk, not a design change.

## Open Risks / Follow-ups (out of scope here)

- Result streaming/pagination for large reads (downstream UX task).
- Connection-string import/export helper.
- Per-connection statement timeout + row cap as an additional safety rail (the policy layer is the natural home; deferred until an upper entry needs it).
- Audit logging of executed SQL per caller (the `db-service` chokepoint is where it will hook).
