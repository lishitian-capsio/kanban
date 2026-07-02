# SQL-compatible engine expansion (MariaDB · CockroachDB · TimescaleDB)

Extends the Bun.SQL remote driver (`src/db/driver/bun-sql/`) to more SQL engines by reusing the
existing Postgres/MySQL dialects, keyed on **wire protocol** rather than product identity.

## Research findings

### Bun.SQL supported wire protocols
`node_modules/bun-types/sql.d.ts` declares exactly four `SQL.Options.adapter` values:
`"postgres"`, `"mysql"`, `"mariadb"`, `"sqlite"`. There are only **two remote wire protocols** —
Postgres and MySQL. Every "SQL-compatible" engine ultimately connects over one of them; `mariadb`
is a protocol-aware alias adapter for the MySQL protocol.

### Postgres vs MySQL dialect differences (the `EngineDialect` seam)
| dimension | postgres | mysql |
|---|---|---|
| introspection | `information_schema` + `pg_catalog` (`pg_index`/`pg_constraint`), `$n` params | `information_schema` (upper-case cols, `COLUMN_KEY='PRI'`, `STATISTICS`, `KEY_COLUMN_USAGE`), `?` params |
| read-only tx open | `BEGIN TRANSACTION READ ONLY` | `START TRANSACTION READ ONLY` |
| statement timeout | `SET LOCAL statement_timeout = <ms>` (tx-scoped, no reset) | `SET max_execution_time = <ms>` (session, reset) |
| version probe | `SELECT version()` | `SELECT VERSION()` |
| identifier quoting | double-quote | backtick |
| bind params | `$1,$2,…` | `?` |
| node-sql-parser dialect | `postgresql` | `mysql` |

### The wire-protocol vs product-identity trap
`DatabaseEngine` was consumed by four wire-protocol-dependent sites — identifier quoting
(`query-builder/identifier.ts`, `execution/query-keyset.ts`), bind-parameter style, and the
node-sql-parser dialect (`policy/sql-classifier.ts`, `policy/single-table-write.ts`). A bare
`engine === "mysql"` check silently takes the wrong branch for a new family member (e.g. MariaDB
would have been double-quoted). **Fix:** a single `engineWireProtocol(engine)` map in
`src/db/types.ts`; all four sites now dispatch on the protocol, so a new protocol-compatible engine
is one line in the map plus a dialect registration — no new branch in each call site.

## What shipped

- **`engineWireProtocol` + `WireProtocol`** (`src/db/types.ts`) — single source of truth for the
  protocol-dependent decisions. `DatabaseEngine` widened to
  `postgres | cockroachdb | timescaledb | mysql | mariadb | sqlite | redis`.
- **Dialect factories** — `createPostgresDialect` / `createMysqlDialect` parameterize the engine id,
  Bun adapter, and timeout statements while sharing introspection SQL, quoting, and read-only tx logic.
- **New dialects/drivers** (registered in `bun-sql/register.ts`):
  - `cockroachdb` (pg family): pg introspection + adapter `postgres`, but `SET LOCAL statement_timeout`
    is unreliable on CockroachDB, so it uses session-scoped `SET statement_timeout = <ms>` + reset `= 0`.
  - `timescaledb` (pg family): a Postgres extension — a pure alias, zero dialect override.
  - `mariadb` (mysql family): adapter `mariadb`; MariaDB has no `max_execution_time`, so it uses
    `SET max_statement_time = <seconds>` (ms/1000, decimal) + reset `= 0`.
- **Enum parity** — `runtimeDbEngineSchema` (contract), `databaseEngineSchema` (record), CLI
  `VALID_ENGINES`, UI `ENGINE_LABELS`/`DEFAULT_PORT`/`ENGINE_TAG` all extended. A compile-time
  bidirectional parity guard in `connection-record.ts` fails typecheck if the zod enum and the
  `DatabaseEngine` union ever drift.

## Read-only / access-gate: no regression
`policy/access-policy.ts` gates on `caller` + `connectionAllowsWrites` — engine-agnostic. New SQL
engines inherit read-only enforcement automatically: `classifySql` maps them to the right parser
dialect, and the driver wraps reads in the dialect's read-only transaction. `allowWrites` is still
forced off only for redis; the new SQL engines behave like postgres/mysql (write-capable in the
human path, read-only for CLI/agent).

## Verification status
| engine | status | notes |
|---|---|---|
| PostgreSQL / MySQL / SQLite / Redis | verified (existing) | unchanged behavior, full suite green |
| **MariaDB** | unit-verified (injected fake) | mysql-family dialect + `mariadb` adapter + `max_statement_time`; no live instance run |
| **CockroachDB** | unit-verified (injected fake) | pg-family dialect + session `statement_timeout`; `pg_catalog` introspection assumed pg-compatible, not run live |
| **TimescaleDB** | unit-verified (injected fake) | identical to Postgres over the wire |

**Not run against real instances** — the dev/CI environment has no Docker daemon. vitest covers the
dialects via the injected `BunSqlLike` fake (`test/runtime/db/new-engine-dialects.test.ts`,
`query-builder.test.ts`, `query-keyset.test.ts`, `sql-classifier.test.ts`,
`engine-wire-protocol.test.ts`); the real-client path stays covered by the Bun sqlite-adapter test.
Live smoke against `cockroachdb`/`mariadb`/`timescaledb` containers is a follow-up when a Docker host
is available.

## Adding the next SQL-compatible engine
1. Add the id to `DatabaseEngine` and the `engineWireProtocol` switch.
2. Register a dialect in `bun-sql/register.ts` (reuse `createPostgresDialect`/`createMysqlDialect`;
   only override timeout statements if the engine differs).
3. Extend the three zod/CLI/UI enum lists (the parity guard + `Record<RuntimeDbEngine>` typecheck
   will flag anything missed).
