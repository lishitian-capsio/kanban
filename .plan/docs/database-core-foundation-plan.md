# Database Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared, engine-agnostic database access core in `src/db/` — driver abstraction + Postgres/MySQL/SQLite adapters, a workspace connection registry honoring the two-root secret boundary, a per-connection pool manager, and a central read-only-by-default security adjudicator — with no upper entry points (UI/MCP/CLI).

**Architecture:** Four layers under `src/db/`: `driver/` (unified `DatabaseDriver` interface + `pg`/`mysql2`/`better-sqlite3` adapters behind a `driver-registry`), `registry/` (committed secret-free metadata sharded like `committed-provider-store.ts` + machine-home credentials keyed by `connId`), `pool/` (`PoolManager` keyed by `connId`, lazy connect + reuse + idle reclaim), and `policy/` (a single `assertOperationAllowed` chokepoint with defense-in-depth: node-sql-parser classifier + DB-level read-only session). A `db-service.ts` façade composes them so no caller can bypass the policy chokepoint.

**Tech Stack:** TypeScript (Node + Bun runtime), `pg`, `mysql2`, `better-sqlite3`, `node-sql-parser`, `zod`, vitest (`bun vitest run`), the repo's `createLogger` logging facade, `sharded-json-store` + `lockedFileSystem` for persistence.

## Global Constraints

- No `any` types. Prefer types from `pg` / `mysql2` / `better-sqlite3` / `node-sql-parser` over local redefinitions. Standard top-level imports only (no inline/dynamic imports).
- All diagnostics through `createLogger("db:<area>")` from `src/logging`. Never `console.*`.
- Secrets (DB passwords, SSL key/cert material) NEVER written to committed `.kanban` data. They live only in machine-home `~/.kanban/settings/db-credentials.json`. A committed connection record must never carry a secret.
- Committed connection metadata lives under `boardDataHome` (travels with the repo); machine-local state stays in `runtimeHome`/machine-home. Mirror `committed-provider-store.ts` + `agent-provider-config.ts`.
- Default read-only: only `SELECT`/introspection runs without opt-in. Writes require connection-level `allowWrites: true`. The `agent` caller is ALWAYS capped read-only, even when `allowWrites` is true.
- Run tests with `bun vitest run <path> --exclude='**/.kanban/**'` to avoid sibling-worktree capture.
- Do NOT commit unless explicitly asked. (User instruction overrides the per-task `git commit` steps below: run them only if the user has authorized commits; otherwise stop after the passing-test step.)
- Tests live in `test/runtime/db/` and use `createTempDir` from `test/utilities/temp-dir`.

---

### Task 1: Dependencies, shared types, and error classes

**Files:**
- Modify: `package.json` (add deps)
- Create: `src/db/types.ts`
- Create: `src/db/errors.ts`
- Test: `test/runtime/db/errors.test.ts`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces:
  - `type DatabaseEngine = "postgres" | "mysql" | "sqlite"`
  - `type DbCaller = "agent" | "human" | "cli"`
  - `type SqlClassification = "read" | "write" | "ddl" | "unknown"`
  - `interface ConnectionConfig` (engine, host?, port?, database?, user?, filePath?, ssl?, password?, sslKeyPem?, sslCertPem?)
  - `interface DbSslConfig { mode: "disable" | "require" | "verify-ca" | "verify-full"; caPath?: string }`
  - `interface QueryRequest { sql: string; params?: ReadonlyArray<unknown>; readOnly: boolean }`
  - `interface FieldInfo { name: string; dataTypeId?: number; dataType?: string }`
  - `interface QueryResult { rows: Array<Record<string, unknown>>; fields: FieldInfo[]; rowCount: number; durationMs: number }`
  - `interface ColumnInfo { name: string; dataType: string; nullable: boolean; isPrimaryKey: boolean; defaultValue: string | null }`
  - `interface TableInfo { schema: string; name: string; kind: "table" | "view"; columns: ColumnInfo[] }`
  - `interface SchemaIntrospection { engine: DatabaseEngine; tables: TableInfo[] }`
  - `interface TestConnectionResult { ok: boolean; latencyMs: number; serverVersion: string | null }`
  - Error classes: `DbError` (base), `DbPolicyError`, `MultiStatementError`, `DbConnectionError`, `CredentialNotConfiguredError`, `UnsupportedEngineError`, `DbQueryError`.

- [ ] **Step 1: Add dependencies**

Run:
```bash
npm install pg mysql2 better-sqlite3 node-sql-parser
npm install --save-dev @types/pg @types/better-sqlite3
```
Expected: all four runtime deps + two type packages appear in `package.json`. (`mysql2` and `node-sql-parser` ship their own types.)

- [ ] **Step 2: Write `src/db/types.ts`**

```ts
/** Database engines the core supports. Extend this union + the driver-registry to add more. */
export type DatabaseEngine = "postgres" | "mysql" | "sqlite";

/** The upper entry on whose behalf an operation runs. Drives policy strictness. */
export type DbCaller = "agent" | "human" | "cli";

/** Read/write classification of a single SQL statement. `unknown` fails closed (treated as write). */
export type SqlClassification = "read" | "write" | "ddl" | "unknown";

/** Non-secret transport security metadata (key/cert material is a secret, kept separate). */
export interface DbSslConfig {
	mode: "disable" | "require" | "verify-ca" | "verify-full";
	caPath?: string;
}

/**
 * A fully-resolved connection config (committed metadata + machine-home secret merged
 * in memory at connect time). `password`/`sslKeyPem`/`sslCertPem` are NEVER persisted
 * in committed data.
 */
export interface ConnectionConfig {
	engine: DatabaseEngine;
	host?: string;
	port?: number;
	database?: string;
	user?: string;
	/** SQLite database file path. */
	filePath?: string;
	ssl?: DbSslConfig;
	password?: string;
	sslKeyPem?: string;
	sslCertPem?: string;
}

/** One statement to execute. `readOnly` is decided by the policy layer, not the driver. */
export interface QueryRequest {
	sql: string;
	params?: ReadonlyArray<unknown>;
	readOnly: boolean;
}

export interface FieldInfo {
	name: string;
	dataTypeId?: number;
	dataType?: string;
}

export interface QueryResult {
	rows: Array<Record<string, unknown>>;
	fields: FieldInfo[];
	rowCount: number;
	durationMs: number;
}

export interface ColumnInfo {
	name: string;
	dataType: string;
	nullable: boolean;
	isPrimaryKey: boolean;
	defaultValue: string | null;
}

export interface TableInfo {
	schema: string;
	name: string;
	kind: "table" | "view";
	columns: ColumnInfo[];
}

export interface SchemaIntrospection {
	engine: DatabaseEngine;
	tables: TableInfo[];
}

export interface TestConnectionResult {
	ok: boolean;
	latencyMs: number;
	serverVersion: string | null;
}
```

- [ ] **Step 3: Write the failing test `test/runtime/db/errors.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import {
	CredentialNotConfiguredError,
	DbError,
	DbPolicyError,
	MultiStatementError,
	UnsupportedEngineError,
} from "../../../src/db/errors";

describe("db errors", () => {
	it("DbPolicyError is a DbError and carries a reason", () => {
		const err = new DbPolicyError("connection is read-only");
		expect(err).toBeInstanceOf(DbError);
		expect(err).toBeInstanceOf(DbPolicyError);
		expect(err.message).toBe("connection is read-only");
		expect(err.name).toBe("DbPolicyError");
	});

	it("UnsupportedEngineError names the engine", () => {
		const err = new UnsupportedEngineError("clickhouse");
		expect(err).toBeInstanceOf(DbError);
		expect(err.message).toContain("clickhouse");
	});

	it("MultiStatementError and CredentialNotConfiguredError extend DbError", () => {
		expect(new MultiStatementError()).toBeInstanceOf(DbError);
		expect(new CredentialNotConfiguredError("conn-1")).toBeInstanceOf(DbError);
		expect(new CredentialNotConfiguredError("conn-1").message).toContain("conn-1");
	});
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/errors.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — cannot resolve `../../../src/db/errors`.

- [ ] **Step 5: Write `src/db/errors.ts`**

```ts
import type { DbCaller, SqlClassification } from "./types";

/** Base class for every error this layer throws, so callers can branch on `instanceof DbError`. */
export class DbError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** A statement was blocked by the security policy (read-only connection or restricted caller). */
export class DbPolicyError extends DbError {
	constructor(
		message: string,
		readonly details?: { caller: DbCaller; classification: SqlClassification },
	) {
		super(message);
	}
}

/** The SQL contained more than one statement; multi-statement execution is refused. */
export class MultiStatementError extends DbError {
	constructor() {
		super("multiple SQL statements are not allowed in a single request");
	}
}

/** Establishing or using the underlying connection failed. */
export class DbConnectionError extends DbError {}

/** No machine-home credential is configured for this connection id. */
export class CredentialNotConfiguredError extends DbError {
	constructor(readonly connId: string) {
		super(`no credential configured for connection "${connId}"`);
	}
}

/** The requested engine has no registered driver factory. */
export class UnsupportedEngineError extends DbError {
	constructor(readonly engine: string) {
		super(`unsupported database engine: "${engine}"`);
	}
}

/** The driver's native query failed; wraps the engine error with a sanitized message. */
export class DbQueryError extends DbError {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
	}
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/errors.test.ts --exclude='**/.kanban/**'`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit** (only if commits authorized)

```bash
git add package.json package-lock.json src/db/types.ts src/db/errors.ts test/runtime/db/errors.test.ts
git commit -m "feat(db): add db core deps, shared types, and error classes"
```

---

### Task 2: SQL classifier

**Files:**
- Create: `src/db/policy/sql-classifier.ts`
- Test: `test/runtime/db/sql-classifier.test.ts`

**Interfaces:**
- Consumes: `DatabaseEngine`, `SqlClassification` from `../types`; `MultiStatementError` from `../errors`.
- Produces: `function classifySql(sql: string, engine: DatabaseEngine): SqlClassification`. Throws `MultiStatementError` when the input parses to more than one statement.

- [ ] **Step 1: Write the failing test `test/runtime/db/sql-classifier.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { MultiStatementError } from "../../../src/db/errors";
import { classifySql } from "../../../src/db/policy/sql-classifier";

describe("classifySql", () => {
	it("classifies plain SELECT as read", () => {
		expect(classifySql("SELECT * FROM users", "postgres")).toBe("read");
	});

	it("classifies a CTE wrapping a SELECT as read", () => {
		expect(classifySql("WITH t AS (SELECT 1) SELECT * FROM t", "postgres")).toBe("read");
	});

	it("classifies INSERT/UPDATE/DELETE as write", () => {
		expect(classifySql("INSERT INTO users (id) VALUES (1)", "postgres")).toBe("write");
		expect(classifySql("UPDATE users SET id = 2", "mysql")).toBe("write");
		expect(classifySql("DELETE FROM users", "sqlite")).toBe("write");
	});

	it("classifies a CTE that wraps a DELETE as write (the parser-not-regex case)", () => {
		expect(classifySql("WITH t AS (SELECT id FROM users) DELETE FROM users", "postgres")).toBe("write");
	});

	it("classifies DDL as ddl", () => {
		expect(classifySql("CREATE TABLE x (id int)", "postgres")).toBe("ddl");
		expect(classifySql("DROP TABLE x", "postgres")).toBe("ddl");
	});

	it("treats unparseable SQL as unknown (fail closed)", () => {
		expect(classifySql("NOTSQL gibberish ;;", "postgres")).toBe("unknown");
	});

	it("rejects multiple statements", () => {
		expect(() => classifySql("SELECT 1; SELECT 2", "postgres")).toThrow(MultiStatementError);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/sql-classifier.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — cannot resolve the classifier module.

- [ ] **Step 3: Write `src/db/policy/sql-classifier.ts`**

```ts
import { Parser } from "node-sql-parser";

import { createLogger } from "../../logging";
import { MultiStatementError } from "../errors";
import type { DatabaseEngine, SqlClassification } from "../types";

const log = createLogger("db:sql-classifier");

const parser = new Parser();

/** node-sql-parser dialect key per engine. */
const PARSER_DIALECT: Record<DatabaseEngine, string> = {
	postgres: "postgresql",
	mysql: "mysql",
	sqlite: "sqlite",
};

/** Statement AST `type` values that only read data. Everything else is non-read. */
const READ_TYPES = new Set(["select"]);
const WRITE_TYPES = new Set(["insert", "update", "delete", "replace"]);
const DDL_TYPES = new Set(["create", "drop", "alter", "truncate", "rename"]);

interface StatementAst {
	type?: string;
}

/**
 * Classify a single SQL statement as read / write / ddl / unknown for the security
 * policy. Uses node-sql-parser so a write hidden behind a CTE or comment is still
 * detected. Throws {@link MultiStatementError} for more than one statement. An
 * unparseable statement classifies as `unknown` (the policy treats that as a write —
 * fail closed).
 */
export function classifySql(sql: string, engine: DatabaseEngine): SqlClassification {
	let ast: StatementAst | StatementAst[];
	try {
		ast = parser.astify(sql, { database: PARSER_DIALECT[engine] }) as StatementAst | StatementAst[];
	} catch (error) {
		log.debug("sql parse failed; classifying as unknown", { engine, error });
		return "unknown";
	}

	const statements = Array.isArray(ast) ? ast : [ast];
	if (statements.length === 0) {
		return "unknown";
	}
	if (statements.length > 1) {
		throw new MultiStatementError();
	}

	const type = (statements[0]?.type ?? "").toLowerCase();
	if (READ_TYPES.has(type)) {
		return "read";
	}
	if (WRITE_TYPES.has(type)) {
		return "write";
	}
	if (DDL_TYPES.has(type)) {
		return "ddl";
	}
	return "unknown";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/sql-classifier.test.ts --exclude='**/.kanban/**'`
Expected: PASS (7 tests).

> If node-sql-parser classifies `WITH ... DELETE` with `type: "delete"` (expected) the CTE-write test passes. If a future parser version returns a different shape, the `unknown` fallback keeps it fail-closed.

- [ ] **Step 5: Commit** (only if commits authorized)

```bash
git add src/db/policy/sql-classifier.ts test/runtime/db/sql-classifier.test.ts
git commit -m "feat(db): add node-sql-parser SQL read/write classifier"
```

---

### Task 3: Access policy (the central adjudicator)

**Files:**
- Create: `src/db/policy/access-policy.ts`
- Test: `test/runtime/db/access-policy.test.ts`

**Interfaces:**
- Consumes: `classifySql` from `./sql-classifier`; `DbCaller`, `DatabaseEngine`, `SqlClassification` from `../types`; `DbPolicyError` from `../errors`.
- Produces:
  - `interface AccessPolicyInput { sql: string; engine: DatabaseEngine; caller: DbCaller; connectionAllowsWrites: boolean }`
  - `interface ResolvedOperation { classification: SqlClassification; readOnly: boolean }`
  - `function assertOperationAllowed(input: AccessPolicyInput): ResolvedOperation` — throws `DbPolicyError` when a write is blocked; throws `MultiStatementError` (via the classifier) for multi-statement input.

- [ ] **Step 1: Write the failing test `test/runtime/db/access-policy.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { DbPolicyError } from "../../../src/db/errors";
import { assertOperationAllowed } from "../../../src/db/policy/access-policy";
import type { DbCaller } from "../../../src/db/types";

function run(sql: string, caller: DbCaller, connectionAllowsWrites: boolean) {
	return assertOperationAllowed({ sql, engine: "postgres", caller, connectionAllowsWrites });
}

describe("assertOperationAllowed", () => {
	it("allows reads for every caller regardless of write permission", () => {
		for (const caller of ["agent", "human", "cli"] as DbCaller[]) {
			const res = run("SELECT 1", caller, false);
			expect(res.classification).toBe("read");
			expect(res.readOnly).toBe(true);
		}
	});

	it("blocks writes when the connection is read-only", () => {
		expect(() => run("DELETE FROM users", "human", false)).toThrow(DbPolicyError);
	});

	it("allows writes for human/cli when the connection opts in", () => {
		const res = run("DELETE FROM users", "human", true);
		expect(res.classification).toBe("write");
		expect(res.readOnly).toBe(false);
	});

	it("ALWAYS caps the agent caller to read-only even when the connection allows writes", () => {
		expect(() => run("DELETE FROM users", "agent", true)).toThrow(DbPolicyError);
	});

	it("treats unknown (unparseable) SQL as a blocked write for a read-only connection", () => {
		expect(() => run("NOTSQL ;;", "human", false)).toThrow(DbPolicyError);
	});

	it("blocks DDL on a read-only connection", () => {
		expect(() => run("CREATE TABLE x (id int)", "cli", false)).toThrow(DbPolicyError);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/access-policy.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — cannot resolve the access-policy module.

- [ ] **Step 3: Write `src/db/policy/access-policy.ts`**

```ts
import { DbPolicyError } from "../errors";
import type { DatabaseEngine, DbCaller, SqlClassification } from "../types";
import { classifySql } from "./sql-classifier";

export interface AccessPolicyInput {
	sql: string;
	engine: DatabaseEngine;
	caller: DbCaller;
	/** Whether the connection record opted into writes (`allowWrites`). */
	connectionAllowsWrites: boolean;
}

export interface ResolvedOperation {
	classification: SqlClassification;
	/** The session mode the driver must open. Reads (and blocked-then-allowed nothing) are read-only. */
	readOnly: boolean;
}

/**
 * The single adjudication point shared by every upper entry (agent / human / cli).
 *
 * Rules (defense-in-depth — the driver ALSO opens a read-only DB session for `readOnly`):
 *  - A `read` statement is always allowed and runs read-only.
 *  - A `write`/`ddl`/`unknown` statement requires the connection to allow writes AND the
 *    caller not to be `agent`. The agent caller is always capped read-only.
 *  - `unknown` (unparseable) fails closed: it is treated as a write.
 */
export function assertOperationAllowed(input: AccessPolicyInput): ResolvedOperation {
	const classification = classifySql(input.sql, input.engine);
	if (classification === "read") {
		return { classification, readOnly: true };
	}

	// Non-read from here on. Agent is always restricted; otherwise the connection must opt in.
	if (input.caller === "agent") {
		throw new DbPolicyError("agent caller is restricted to read-only operations", {
			caller: input.caller,
			classification,
		});
	}
	if (!input.connectionAllowsWrites) {
		throw new DbPolicyError("connection is read-only; writes are not permitted", {
			caller: input.caller,
			classification,
		});
	}
	return { classification, readOnly: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/access-policy.test.ts --exclude='**/.kanban/**'`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit** (only if commits authorized)

```bash
git add src/db/policy/access-policy.ts test/runtime/db/access-policy.test.ts
git commit -m "feat(db): add central read-only-by-default access policy"
```

---

### Task 4: Connection registry store (committed metadata + machine-home credentials)

**Files:**
- Create: `src/db/registry/connection-record.ts`
- Create: `src/db/registry/connection-store.ts`
- Test: `test/runtime/db/connection-store.test.ts`

**Interfaces:**
- Consumes: `readShardDir`/`writeShardDir` from `../../state/sharded-json-store`; `lockedFileSystem` from `../../fs/locked-file-system`; `DatabaseEngine`, `ConnectionConfig`, `DbSslConfig` from `../types`.
- Produces:
  - `connectionRecordSchema` (zod) + `type ConnectionRecord`
  - `dbCredentialSchema` (zod) + `type DbCredential = { password?: string; sslKeyPem?: string; sslCertPem?: string }`
  - `type DbCredentialsData = { credentials: Record<string, DbCredential> }`
  - `function normalizeConnId(id: string): string`
  - `async function readConnections(shardDir: string): Promise<ConnectionRecord[]>`
  - `async function writeConnections(shardDir: string, records: ConnectionRecord[]): Promise<void>`
  - `async function readCredentials(path: string): Promise<DbCredentialsData>`
  - `async function writeCredentials(path: string, data: DbCredentialsData): Promise<void>`
  - `function resolveConnectionConfig(record: ConnectionRecord, credential: DbCredential | undefined): ConnectionConfig`

- [ ] **Step 1: Write the failing test `test/runtime/db/connection-store.test.ts`**

```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	type ConnectionRecord,
	readConnections,
	readCredentials,
	resolveConnectionConfig,
	writeConnections,
	writeCredentials,
} from "../../../src/db/registry/connection-store";
import { createTempDir } from "../../utilities/temp-dir";

function record(connId: string, overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
	return {
		connId,
		label: `db ${connId}`,
		engine: "postgres",
		host: "localhost",
		port: 5432,
		database: "app",
		user: "postgres",
		filePath: null,
		ssl: null,
		allowWrites: false,
		createdAt: "2026-06-22T00:00:00.000Z",
		...overrides,
	};
}

describe("connection-store", () => {
	it("round-trips connection shards", async () => {
		const dir = await createTempDir();
		const shardDir = join(dir, "db-connections");
		await writeConnections(shardDir, [record("a"), record("b", { allowWrites: true })]);

		const loaded = await readConnections(shardDir);
		expect(loaded.map((r) => r.connId).sort()).toEqual(["a", "b"]);
		expect(loaded.find((r) => r.connId === "b")?.allowWrites).toBe(true);

		const files = (await readdir(shardDir)).sort();
		expect(files).toEqual(["a.json", "b.json"]);
	});

	it("deletes shards absent from the next write", async () => {
		const dir = await createTempDir();
		const shardDir = join(dir, "db-connections");
		await writeConnections(shardDir, [record("a"), record("b")]);
		await writeConnections(shardDir, [record("a")]);
		const files = await readdir(shardDir);
		expect(files).toEqual(["a.json"]);
	});

	it("round-trips credentials in a single machine-home file", async () => {
		const dir = await createTempDir();
		const path = join(dir, "db-credentials.json");
		await writeCredentials(path, { credentials: { a: { password: "secret" } } });
		const loaded = await readCredentials(path);
		expect(loaded.credentials.a?.password).toBe("secret");
	});

	it("returns empty credentials when the file is missing", async () => {
		const dir = await createTempDir();
		const loaded = await readCredentials(join(dir, "missing.json"));
		expect(loaded).toEqual({ credentials: {} });
	});

	it("merges record + credential into a ConnectionConfig (secret only in memory)", () => {
		const config = resolveConnectionConfig(record("a"), { password: "secret" });
		expect(config.engine).toBe("postgres");
		expect(config.host).toBe("localhost");
		expect(config.password).toBe("secret");
	});

	it("merges with no credential (password undefined)", () => {
		const config = resolveConnectionConfig(record("a"), undefined);
		expect(config.password).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/connection-store.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — cannot resolve the connection-store module.

- [ ] **Step 3: Write `src/db/registry/connection-record.ts`**

```ts
import { z } from "zod";

export const databaseEngineSchema = z.enum(["postgres", "mysql", "sqlite"]);

export const dbSslConfigSchema = z.object({
	mode: z.enum(["disable", "require", "verify-ca", "verify-full"]),
	caPath: z.string().optional(),
});

/**
 * Committed, secret-free connection metadata. Sharded one-file-per-`connId` under the
 * board-data home so cross-branch edits never collide. NEVER carries a password or key.
 */
export const connectionRecordSchema = z.object({
	connId: z.string().min(1),
	label: z.string().min(1),
	engine: databaseEngineSchema,
	host: z.string().nullable(),
	port: z.number().int().positive().nullable(),
	database: z.string().nullable(),
	user: z.string().nullable(),
	filePath: z.string().nullable(),
	ssl: dbSslConfigSchema.nullable(),
	/** Connection-level write opt-in. Default false ⇒ the connection is read-only. */
	allowWrites: z.boolean().default(false),
	/** ISO timestamp; supplied by the caller (no Date.now() in stored/pure code). */
	createdAt: z.string(),
});
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>;

/** Machine-home secret for one connection. Lives ONLY in ~/.kanban, never committed. */
export const dbCredentialSchema = z.object({
	password: z.string().optional(),
	sslKeyPem: z.string().optional(),
	sslCertPem: z.string().optional(),
});
export type DbCredential = z.infer<typeof dbCredentialSchema>;

export const dbCredentialsDataSchema = z.object({
	credentials: z.record(z.string(), dbCredentialSchema).default({}),
});
export type DbCredentialsData = z.infer<typeof dbCredentialsDataSchema>;
```

- [ ] **Step 4: Write `src/db/registry/connection-store.ts`**

```ts
import { readFile } from "node:fs/promises";

import { lockedFileSystem } from "../../fs/locked-file-system";
import { readShardDir, writeShardDir } from "../../state/sharded-json-store";
import type { ConnectionConfig } from "../types";
import {
	type ConnectionRecord,
	type DbCredential,
	type DbCredentialsData,
	connectionRecordSchema,
	dbCredentialsDataSchema,
} from "./connection-record";

export type { ConnectionRecord, DbCredential, DbCredentialsData };

/** The id used to address a connection (its normalized id) — also the shard filename. */
export function normalizeConnId(id: string): string {
	return id.trim().toLowerCase();
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Read + assemble all committed connection records from their per-id shards. */
export async function readConnections(shardDir: string): Promise<ConnectionRecord[]> {
	const shardMap = await readShardDir(shardDir, connectionRecordSchema);
	return [...shardMap.values()];
}

/** Persist connection records: one shard per `connId`. Shards absent from `records` are deleted. */
export async function writeConnections(shardDir: string, records: ConnectionRecord[]): Promise<void> {
	const shardMap = new Map<string, ConnectionRecord>(records.map((r) => [r.connId, r]));
	await writeShardDir(shardDir, shardMap);
}

/** Read the machine-home credentials file. Missing/torn file ⇒ empty credentials. */
export async function readCredentials(path: string): Promise<DbCredentialsData> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = dbCredentialsDataSchema.safeParse(JSON.parse(raw) as unknown);
		return parsed.success ? parsed.data : { credentials: {} };
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			// Torn/invalid secret file: treat as empty rather than crash; next write heals it.
		}
		return { credentials: {} };
	}
}

/** Persist the machine-home credentials file (machine-local; no repo lock). */
export async function writeCredentials(path: string, data: DbCredentialsData): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, data, { lock: null });
}

/**
 * Merge committed metadata + the machine-home secret into a full {@link ConnectionConfig}.
 * The secret exists only in the returned in-memory object — it is never written to committed data.
 */
export function resolveConnectionConfig(
	record: ConnectionRecord,
	credential: DbCredential | undefined,
): ConnectionConfig {
	return {
		engine: record.engine,
		host: record.host ?? undefined,
		port: record.port ?? undefined,
		database: record.database ?? undefined,
		user: record.user ?? undefined,
		filePath: record.filePath ?? undefined,
		ssl: record.ssl ?? undefined,
		password: credential?.password,
		sslKeyPem: credential?.sslKeyPem,
		sslCertPem: credential?.sslCertPem,
	};
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/connection-store.test.ts --exclude='**/.kanban/**'`
Expected: PASS (6 tests).

> If `lockedFileSystem.writeJsonFileAtomic` requires the parent dir to exist, the test will reveal it; `writeShardDir` already `mkdir`s its dir. For the credentials file, add a `mkdir -p` of `dirname(path)` inside `writeCredentials` if the test surfaces an ENOENT (check `sharded-json-store.ts`/`locked-file-system.ts` behavior first — mirror whatever `agent-provider-config.ts` does).

- [ ] **Step 6: Commit** (only if commits authorized)

```bash
git add src/db/registry/connection-record.ts src/db/registry/connection-store.ts test/runtime/db/connection-store.test.ts
git commit -m "feat(db): add connection registry store (committed metadata + machine-home secrets)"
```

---

### Task 5: Driver interface + driver registry

**Files:**
- Create: `src/db/driver/driver.ts`
- Create: `src/db/driver/driver-registry.ts`
- Test: `test/runtime/db/driver-registry.test.ts`

**Interfaces:**
- Consumes: `ConnectionConfig`, `QueryRequest`, `QueryResult`, `SchemaIntrospection`, `TestConnectionResult`, `DatabaseEngine` from `../types`; `UnsupportedEngineError` from `../errors`.
- Produces:
  - `interface DatabaseDriver { readonly engine; connect(); disconnect(); testConnection(); query(req); introspect() }`
  - `type DriverFactory = (config: ConnectionConfig) => DatabaseDriver`
  - `function registerDriver(engine: DatabaseEngine, factory: DriverFactory): void`
  - `function createDriver(config: ConnectionConfig): DatabaseDriver` — throws `UnsupportedEngineError` for an unregistered engine.

- [ ] **Step 1: Write the failing test `test/runtime/db/driver-registry.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { createDriver, registerDriver } from "../../../src/db/driver/driver-registry";
import type { DatabaseDriver } from "../../../src/db/driver/driver";
import { UnsupportedEngineError } from "../../../src/db/errors";
import type { ConnectionConfig } from "../../../src/db/types";

function fakeDriver(config: ConnectionConfig): DatabaseDriver {
	return {
		engine: config.engine,
		connect: async () => {},
		disconnect: async () => {},
		testConnection: async () => ({ ok: true, latencyMs: 0, serverVersion: null }),
		query: async () => ({ rows: [], fields: [], rowCount: 0, durationMs: 0 }),
		introspect: async () => ({ engine: config.engine, tables: [] }),
	};
}

describe("driver-registry", () => {
	it("creates a registered driver", () => {
		registerDriver("postgres", fakeDriver);
		const driver = createDriver({ engine: "postgres", host: "h" });
		expect(driver.engine).toBe("postgres");
	});

	it("throws UnsupportedEngineError for an unregistered engine", () => {
		expect(() => createDriver({ engine: "mysql" } as ConnectionConfig)).toThrow(UnsupportedEngineError);
	});
});
```

> This test registers only `postgres`, so it must run isolated from the adapter-registration side effects of later tasks. Keep it order-independent: the adapter tasks register their own engine inside their own module import; this test imports `driver-registry` directly and registers its fake. (`mysql` may already be registered if an adapter module was imported transitively — if so, change the negative case to a guaranteed-unregistered engine literal cast, e.g. `"clickhouse" as DatabaseEngine`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/driver-registry.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — cannot resolve the driver/driver-registry modules.

- [ ] **Step 3: Write `src/db/driver/driver.ts`**

```ts
import type {
	ConnectionConfig,
	DatabaseEngine,
	QueryRequest,
	QueryResult,
	SchemaIntrospection,
	TestConnectionResult,
} from "../types";

export type { ConnectionConfig };

/**
 * The engine-agnostic driver contract. Every adapter (Postgres/MySQL/SQLite/…)
 * implements exactly this surface so the pool manager and service treat all engines
 * identically. `query` trusts the `readOnly` flag the policy layer resolved and opens
 * the matching DB-level session mode (defense-in-depth).
 */
export interface DatabaseDriver {
	readonly engine: DatabaseEngine;
	/** Establish the underlying pool/handle. Idempotent — safe to call repeatedly. */
	connect(): Promise<void>;
	/** Tear down the pool/handle and release sockets/file handles. */
	disconnect(): Promise<void>;
	/** Cheap liveness probe (SELECT 1 / PRAGMA). */
	testConnection(): Promise<TestConnectionResult>;
	/** Execute one statement in the resolved session mode. */
	query(request: QueryRequest): Promise<QueryResult>;
	/** Read the catalog, normalized to {@link SchemaIntrospection}. Always read-only. */
	introspect(): Promise<SchemaIntrospection>;
}
```

- [ ] **Step 4: Write `src/db/driver/driver-registry.ts`**

```ts
import { UnsupportedEngineError } from "../errors";
import type { ConnectionConfig, DatabaseEngine } from "../types";
import type { DatabaseDriver } from "./driver";

export type DriverFactory = (config: ConnectionConfig) => DatabaseDriver;

const registry = new Map<DatabaseEngine, DriverFactory>();

/** Register a driver factory for an engine. The single extension point for new engines. */
export function registerDriver(engine: DatabaseEngine, factory: DriverFactory): void {
	registry.set(engine, factory);
}

/** Build a driver for the config's engine. Throws {@link UnsupportedEngineError} if none registered. */
export function createDriver(config: ConnectionConfig): DatabaseDriver {
	const factory = registry.get(config.engine);
	if (!factory) {
		throw new UnsupportedEngineError(config.engine);
	}
	return factory(config);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/driver-registry.test.ts --exclude='**/.kanban/**'`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit** (only if commits authorized)

```bash
git add src/db/driver/driver.ts src/db/driver/driver-registry.ts test/runtime/db/driver-registry.test.ts
git commit -m "feat(db): add driver interface and engine registry"
```

---

### Task 6: SQLite adapter (`better-sqlite3`)

**Files:**
- Create: `src/db/driver/sqlite-driver.ts`
- Test: `test/runtime/db/sqlite-driver.test.ts`

**Interfaces:**
- Consumes: `DatabaseDriver` from `./driver`; `registerDriver` from `./driver-registry`; `ConnectionConfig`, `QueryRequest`, `QueryResult`, `SchemaIntrospection`, `TestConnectionResult` from `../types`; `DbConnectionError`, `DbQueryError`, `DbPolicyError` from `../errors`.
- Produces: `class SqliteDriver implements DatabaseDriver` + a module side-effect `registerDriver("sqlite", (c) => new SqliteDriver(c))`. Real hermetic tests (temp file DB).

- [ ] **Step 1: Write the failing test `test/runtime/db/sqlite-driver.test.ts`**

```ts
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SqliteDriver } from "../../../src/db/driver/sqlite-driver";
import { DbPolicyError } from "../../../src/db/errors";
import { createTempDir } from "../../utilities/temp-dir";

async function seededDbPath(): Promise<string> {
	const dir = await createTempDir();
	const path = join(dir, "test.db");
	const seed = new Database(path);
	seed.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
	seed.exec("INSERT INTO users (id, name) VALUES (1, 'alice'), (2, 'bob')");
	seed.close();
	return path;
}

describe("SqliteDriver", () => {
	it("connects, queries reads, and reports rows + fields", async () => {
		const filePath = await seededDbPath();
		const driver = new SqliteDriver({ engine: "sqlite", filePath, allowWrites: true } as never);
		await driver.connect();
		const result = await driver.query({ sql: "SELECT id, name FROM users ORDER BY id", readOnly: true });
		expect(result.rowCount).toBe(2);
		expect(result.rows[0]).toEqual({ id: 1, name: "alice" });
		expect(result.fields.map((f) => f.name)).toEqual(["id", "name"]);
		await driver.disconnect();
	});

	it("introspects tables, columns, and primary keys", async () => {
		const filePath = await seededDbPath();
		const driver = new SqliteDriver({ engine: "sqlite", filePath } as never);
		await driver.connect();
		const schema = await driver.introspect();
		const users = schema.tables.find((t) => t.name === "users");
		expect(users?.columns.find((c) => c.name === "id")?.isPrimaryKey).toBe(true);
		expect(users?.columns.find((c) => c.name === "name")?.nullable).toBe(false);
		await driver.disconnect();
	});

	it("rejects a write when the request is readOnly (DB-level guard)", async () => {
		const filePath = await seededDbPath();
		const driver = new SqliteDriver({ engine: "sqlite", filePath } as never);
		await driver.connect();
		await expect(
			driver.query({ sql: "INSERT INTO users (id, name) VALUES (3, 'carol')", readOnly: true }),
		).rejects.toBeInstanceOf(DbPolicyError);
		await driver.disconnect();
	});

	it("testConnection returns ok with a server version", async () => {
		const filePath = await seededDbPath();
		const driver = new SqliteDriver({ engine: "sqlite", filePath } as never);
		await driver.connect();
		const res = await driver.testConnection();
		expect(res.ok).toBe(true);
		expect(res.serverVersion).toBeTypeOf("string");
		await driver.disconnect();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/sqlite-driver.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — cannot resolve the sqlite-driver module.

- [ ] **Step 3: Write `src/db/driver/sqlite-driver.ts`**

```ts
import Database from "better-sqlite3";

import { createLogger } from "../../logging";
import { DbConnectionError, DbPolicyError, DbQueryError } from "../errors";
import type {
	ColumnInfo,
	ConnectionConfig,
	QueryRequest,
	QueryResult,
	SchemaIntrospection,
	TableInfo,
	TestConnectionResult,
} from "../types";
import type { DatabaseDriver } from "./driver";
import { registerDriver } from "./driver-registry";

const log = createLogger("db:sqlite-driver");

interface SqliteMasterRow {
	name: string;
	type: string;
}
interface PragmaColumnRow {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

/** SQLite adapter on better-sqlite3. Synchronous engine wrapped in the async driver contract. */
export class SqliteDriver implements DatabaseDriver {
	readonly engine = "sqlite" as const;
	private db: Database.Database | null = null;

	constructor(private readonly config: ConnectionConfig & { allowWrites?: boolean }) {}

	async connect(): Promise<void> {
		if (this.db) {
			return;
		}
		if (!this.config.filePath) {
			throw new DbConnectionError("sqlite connection requires a filePath");
		}
		try {
			// Open read-only at the handle level unless the connection opted into writes.
			this.db = new Database(this.config.filePath, { readonly: this.config.allowWrites !== true });
		} catch (error) {
			throw new DbConnectionError(`failed to open sqlite database: ${String(error)}`);
		}
	}

	async disconnect(): Promise<void> {
		this.db?.close();
		this.db = null;
	}

	private require(): Database.Database {
		if (!this.db) {
			throw new DbConnectionError("sqlite driver is not connected");
		}
		return this.db;
	}

	async testConnection(): Promise<TestConnectionResult> {
		const started = performance.now();
		const db = this.require();
		const version = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
		return { ok: true, latencyMs: performance.now() - started, serverVersion: version.v };
	}

	async query(request: QueryRequest): Promise<QueryResult> {
		const db = this.require();
		const started = performance.now();
		let stmt: Database.Statement;
		try {
			stmt = db.prepare(request.sql);
		} catch (error) {
			throw new DbQueryError(`sqlite prepare failed: ${String(error)}`, error);
		}
		// DB-level read-only guard (defense-in-depth alongside the policy classifier).
		if (request.readOnly && !stmt.reader) {
			throw new DbPolicyError("statement is not read-only but was requested as read-only");
		}
		try {
			if (stmt.reader) {
				const rows = (request.params ? stmt.all(...request.params) : stmt.all()) as Array<Record<string, unknown>>;
				const fields = stmt.columns().map((c) => ({ name: c.name, dataType: c.type ?? undefined }));
				return { rows, fields, rowCount: rows.length, durationMs: performance.now() - started };
			}
			const info = request.params ? stmt.run(...request.params) : stmt.run();
			return { rows: [], fields: [], rowCount: info.changes, durationMs: performance.now() - started };
		} catch (error) {
			throw new DbQueryError(`sqlite query failed: ${String(error)}`, error);
		}
	}

	async introspect(): Promise<SchemaIntrospection> {
		const db = this.require();
		const objects = db
			.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")
			.all() as SqliteMasterRow[];
		const tables: TableInfo[] = objects.map((obj) => {
			const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(obj.name)})`).all() as PragmaColumnRow[];
			const columns: ColumnInfo[] = cols.map((c) => ({
				name: c.name,
				dataType: c.type || "",
				nullable: c.notnull === 0,
				isPrimaryKey: c.pk > 0,
				defaultValue: c.dflt_value,
			}));
			return { schema: "main", name: obj.name, kind: obj.type === "view" ? "view" : "table", columns };
		});
		log.debug("sqlite introspect complete", { tableCount: tables.length });
		return { engine: this.engine, tables };
	}
}

registerDriver("sqlite", (config) => new SqliteDriver(config as ConnectionConfig & { allowWrites?: boolean }));
```

> Note: `ConnectionConfig` has no `allowWrites` field (that lives on the record). The pool manager passes it through; for SQLite the driver needs it to decide the handle mode, so `SqliteDriver` accepts it as an optional extra on the config object. Task 10 (`db-service`) sets `config.allowWrites` from the record before `createDriver`. Keep this documented; do not add `allowWrites` to the shared `ConnectionConfig` (it is a record-level concept, not a connection field).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/sqlite-driver.test.ts --exclude='**/.kanban/**'`
Expected: PASS (4 tests). If `better-sqlite3` fails to load (native build), STOP and report — this is the flagged implementation risk; the registry design allows swapping to `node:sqlite` without touching callers.

- [ ] **Step 5: Commit** (only if commits authorized)

```bash
git add src/db/driver/sqlite-driver.ts test/runtime/db/sqlite-driver.test.ts
git commit -m "feat(db): add SQLite driver adapter (better-sqlite3)"
```

---

### Task 7: Postgres adapter (`pg`)

**Files:**
- Create: `src/db/driver/postgres-driver.ts`
- Test: `test/runtime/db/postgres-driver.test.ts`

**Interfaces:**
- Consumes: same driver/types/errors as Task 6; `Pool`, `PoolConfig`, `QueryResult as PgQueryResult` from `pg`.
- Produces: `class PostgresDriver implements DatabaseDriver` with a constructor that accepts an optional injected pool factory for testing: `constructor(config: ConnectionConfig, poolFactory?: (cfg: PoolConfig) => PgPoolLike)`. Module side-effect `registerDriver("postgres", ...)`. Also exports `interface PgPoolLike` (the minimal `pg.Pool` surface used: `connect()`, `query()`, `end()`) so tests can inject a fake without a real server.

- [ ] **Step 1: Write the failing test `test/runtime/db/postgres-driver.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { PostgresDriver, type PgPoolLike } from "../../../src/db/driver/postgres-driver";
import type { ConnectionConfig } from "../../../src/db/types";

interface RecordedCall {
	text: string;
	values?: unknown[];
}

function fakePool(): { pool: PgPoolLike; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const client = {
		query: async (text: string, values?: unknown[]) => {
			calls.push({ text, values });
			if (text.startsWith("SELECT")) {
				return { rows: [{ one: 1 }], fields: [{ name: "one", dataTypeID: 23 }], rowCount: 1 };
			}
			return { rows: [], fields: [], rowCount: 0 };
		},
		release: () => {},
	};
	const pool: PgPoolLike = {
		connect: async () => client,
		query: async (text: string, values?: unknown[]) => {
			calls.push({ text, values });
			return { rows: [{ v: "PostgreSQL 16.0" }], fields: [{ name: "v", dataTypeID: 25 }], rowCount: 1 };
		},
		end: async () => {},
	};
	return { pool, calls };
}

const config: ConnectionConfig = { engine: "postgres", host: "h", database: "d", user: "u" };

describe("PostgresDriver", () => {
	it("wraps a read query in a READ ONLY transaction", async () => {
		const { pool, calls } = fakePool();
		const driver = new PostgresDriver(config, () => pool);
		await driver.connect();
		const result = await driver.query({ sql: "SELECT 1 AS one", readOnly: true });
		expect(result.rows).toEqual([{ one: 1 }]);
		expect(result.fields[0].name).toBe("one");
		// The client path opened a read-only transaction.
		const texts = calls.map((c) => c.text);
		expect(texts).toContain("BEGIN TRANSACTION READ ONLY");
		expect(texts).toContain("COMMIT");
		await driver.disconnect();
	});

	it("runs a write query without the read-only transaction when readOnly is false", async () => {
		const { pool, calls } = fakePool();
		const driver = new PostgresDriver(config, () => pool);
		await driver.connect();
		await driver.query({ sql: "UPDATE t SET a = 1", readOnly: false });
		expect(calls.map((c) => c.text)).not.toContain("BEGIN TRANSACTION READ ONLY");
		await driver.disconnect();
	});

	it("testConnection reports the server version", async () => {
		const { pool } = fakePool();
		const driver = new PostgresDriver(config, () => pool);
		await driver.connect();
		const res = await driver.testConnection();
		expect(res.ok).toBe(true);
		expect(res.serverVersion).toContain("PostgreSQL");
		await driver.disconnect();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/postgres-driver.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — cannot resolve the postgres-driver module.

- [ ] **Step 3: Write `src/db/driver/postgres-driver.ts`**

```ts
import { Pool, type PoolConfig } from "pg";

import { createLogger } from "../../logging";
import { DbConnectionError, DbQueryError } from "../errors";
import type {
	ColumnInfo,
	ConnectionConfig,
	QueryRequest,
	QueryResult,
	SchemaIntrospection,
	TableInfo,
	TestConnectionResult,
} from "../types";
import type { DatabaseDriver } from "./driver";
import { registerDriver } from "./driver-registry";

const log = createLogger("db:postgres-driver");

interface PgRow {
	[key: string]: unknown;
}
interface PgResultLike {
	rows: PgRow[];
	fields: Array<{ name: string; dataTypeID?: number }>;
	rowCount: number | null;
}
interface PgClientLike {
	query(text: string, values?: unknown[]): Promise<PgResultLike>;
	release(): void;
}
/** The minimal `pg.Pool` surface this driver uses — lets tests inject a fake. */
export interface PgPoolLike {
	connect(): Promise<PgClientLike>;
	query(text: string, values?: unknown[]): Promise<PgResultLike>;
	end(): Promise<void>;
}

export type PgPoolFactory = (config: PoolConfig) => PgPoolLike;

function toPoolConfig(config: ConnectionConfig): PoolConfig {
	const ssl =
		config.ssl && config.ssl.mode !== "disable"
			? { rejectUnauthorized: config.ssl.mode === "verify-full" || config.ssl.mode === "verify-ca" }
			: undefined;
	return {
		host: config.host,
		port: config.port,
		database: config.database,
		user: config.user,
		password: config.password,
		ssl,
	};
}

export class PostgresDriver implements DatabaseDriver {
	readonly engine = "postgres" as const;
	private pool: PgPoolLike | null = null;

	constructor(
		private readonly config: ConnectionConfig,
		private readonly poolFactory: PgPoolFactory = (cfg) => new Pool(cfg) as unknown as PgPoolLike,
	) {}

	async connect(): Promise<void> {
		if (this.pool) {
			return;
		}
		this.pool = this.poolFactory(toPoolConfig(this.config));
	}

	async disconnect(): Promise<void> {
		await this.pool?.end();
		this.pool = null;
	}

	private require(): PgPoolLike {
		if (!this.pool) {
			throw new DbConnectionError("postgres driver is not connected");
		}
		return this.pool;
	}

	async testConnection(): Promise<TestConnectionResult> {
		const started = performance.now();
		const result = await this.require().query("SELECT version() AS v");
		const version = (result.rows[0]?.v as string | undefined) ?? null;
		return { ok: true, latencyMs: performance.now() - started, serverVersion: version };
	}

	async query(request: QueryRequest): Promise<QueryResult> {
		const pool = this.require();
		const started = performance.now();
		const params = request.params ? [...request.params] : undefined;
		if (request.readOnly) {
			const client = await pool.connect();
			try {
				await client.query("BEGIN TRANSACTION READ ONLY");
				const result = await client.query(request.sql, params);
				await client.query("COMMIT");
				return this.toResult(result, started);
			} catch (error) {
				try {
					await client.query("ROLLBACK");
				} catch {
					// best-effort rollback
				}
				throw new DbQueryError(`postgres query failed: ${String(error)}`, error);
			} finally {
				client.release();
			}
		}
		try {
			const result = await pool.query(request.sql, params);
			return this.toResult(result, started);
		} catch (error) {
			throw new DbQueryError(`postgres query failed: ${String(error)}`, error);
		}
	}

	private toResult(result: PgResultLike, started: number): QueryResult {
		return {
			rows: result.rows,
			fields: result.fields.map((f) => ({ name: f.name, dataTypeId: f.dataTypeID })),
			rowCount: result.rowCount ?? result.rows.length,
			durationMs: performance.now() - started,
		};
	}

	async introspect(): Promise<SchemaIntrospection> {
		const pool = this.require();
		const sql = `
			SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type,
			       c.is_nullable, c.column_default,
			       (pk.column_name IS NOT NULL) AS is_primary_key
			FROM information_schema.columns c
			JOIN information_schema.tables t
			  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
			LEFT JOIN (
			  SELECT kcu.table_schema, kcu.table_name, kcu.column_name
			  FROM information_schema.table_constraints tc
			  JOIN information_schema.key_column_usage kcu
			    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
			  WHERE tc.constraint_type = 'PRIMARY KEY'
			) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name
			WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
			ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
		const result = await pool.query(sql);
		return { engine: this.engine, tables: groupColumnsIntoTables(result.rows) };
	}
}

interface FlatColumnRow {
	table_schema: string;
	table_name: string;
	table_type: string;
	column_name: string;
	data_type: string;
	is_nullable: string;
	column_default: string | null;
	is_primary_key: boolean;
}

/** Fold an ordered flat column result into TableInfo[] (shared shape across SQL engines). */
function groupColumnsIntoTables(rows: PgRow[]): TableInfo[] {
	const byTable = new Map<string, TableInfo>();
	for (const raw of rows as unknown as FlatColumnRow[]) {
		const key = `${raw.table_schema}.${raw.table_name}`;
		let table = byTable.get(key);
		if (!table) {
			table = {
				schema: raw.table_schema,
				name: raw.table_name,
				kind: raw.table_type === "VIEW" ? "view" : "table",
				columns: [],
			};
			byTable.set(key, table);
		}
		const column: ColumnInfo = {
			name: raw.column_name,
			dataType: raw.data_type,
			nullable: raw.is_nullable === "YES",
			isPrimaryKey: raw.is_primary_key === true,
			defaultValue: raw.column_default,
		};
		table.columns.push(column);
	}
	return [...byTable.values()];
}

registerDriver("postgres", (config) => new PostgresDriver(config));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/postgres-driver.test.ts --exclude='**/.kanban/**'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit** (only if commits authorized)

```bash
git add src/db/driver/postgres-driver.ts test/runtime/db/postgres-driver.test.ts
git commit -m "feat(db): add Postgres driver adapter (pg) with read-only transaction wrapping"
```

---

### Task 8: MySQL/MariaDB adapter (`mysql2`)

**Files:**
- Create: `src/db/driver/mysql-driver.ts`
- Test: `test/runtime/db/mysql-driver.test.ts`

**Interfaces:**
- Consumes: same driver/types/errors; `mysql2/promise` `createPool`.
- Produces: `class MysqlDriver implements DatabaseDriver` with optional injected pool factory `constructor(config, poolFactory?)`; exports `interface MysqlPoolLike` (minimal surface: `getConnection()`, `query()`, `end()`). Module side-effect `registerDriver("mysql", ...)`.

- [ ] **Step 1: Write the failing test `test/runtime/db/mysql-driver.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { MysqlDriver, type MysqlPoolLike } from "../../../src/db/driver/mysql-driver";
import type { ConnectionConfig } from "../../../src/db/types";

function fakePool(): { pool: MysqlPoolLike; calls: string[] } {
	const calls: string[] = [];
	const conn = {
		query: async (sql: string) => {
			calls.push(sql);
			if (sql.startsWith("SELECT")) {
				return [[{ one: 1 }], [{ name: "one" }]];
			}
			return [{ affectedRows: 0 }, undefined];
		},
		release: () => {},
	};
	const pool: MysqlPoolLike = {
		getConnection: async () => conn,
		query: async (sql: string) => {
			calls.push(sql);
			return [[{ v: "8.0.36" }], [{ name: "v" }]];
		},
		end: async () => {},
	};
	return { pool, calls };
}

const config: ConnectionConfig = { engine: "mysql", host: "h", database: "d", user: "u" };

describe("MysqlDriver", () => {
	it("wraps a read query in a READ ONLY transaction", async () => {
		const { pool, calls } = fakePool();
		const driver = new MysqlDriver(config, () => pool);
		await driver.connect();
		const result = await driver.query({ sql: "SELECT 1 AS one", readOnly: true });
		expect(result.rows).toEqual([{ one: 1 }]);
		expect(calls).toContain("START TRANSACTION READ ONLY");
		expect(calls).toContain("COMMIT");
		await driver.disconnect();
	});

	it("testConnection reports the server version", async () => {
		const { pool } = fakePool();
		const driver = new MysqlDriver(config, () => pool);
		await driver.connect();
		const res = await driver.testConnection();
		expect(res.ok).toBe(true);
		expect(res.serverVersion).toBe("8.0.36");
		await driver.disconnect();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/mysql-driver.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — cannot resolve the mysql-driver module.

- [ ] **Step 3: Write `src/db/driver/mysql-driver.ts`**

```ts
import { createPool, type Pool as Mysql2Pool, type PoolOptions } from "mysql2/promise";

import { createLogger } from "../../logging";
import { DbConnectionError, DbQueryError } from "../errors";
import type {
	ColumnInfo,
	ConnectionConfig,
	QueryRequest,
	QueryResult,
	SchemaIntrospection,
	TableInfo,
	TestConnectionResult,
} from "../types";
import type { DatabaseDriver } from "./driver";
import { registerDriver } from "./driver-registry";

const log = createLogger("db:mysql-driver");

type Row = Record<string, unknown>;
interface FieldPacketLike {
	name: string;
	columnType?: number;
}
type QueryReturn = [unknown, FieldPacketLike[] | undefined];

interface MysqlConnLike {
	query(sql: string, values?: unknown[]): Promise<QueryReturn>;
	release(): void;
}
/** Minimal `mysql2` pool surface used by this driver — lets tests inject a fake. */
export interface MysqlPoolLike {
	getConnection(): Promise<MysqlConnLike>;
	query(sql: string, values?: unknown[]): Promise<QueryReturn>;
	end(): Promise<void>;
}

export type MysqlPoolFactory = (config: PoolOptions) => MysqlPoolLike;

function toPoolOptions(config: ConnectionConfig): PoolOptions {
	const ssl =
		config.ssl && config.ssl.mode !== "disable"
			? { rejectUnauthorized: config.ssl.mode === "verify-full" || config.ssl.mode === "verify-ca" }
			: undefined;
	return {
		host: config.host,
		port: config.port,
		database: config.database,
		user: config.user,
		password: config.password,
		ssl,
	};
}

function isRowArray(value: unknown): value is Row[] {
	return Array.isArray(value) && value.every((r) => typeof r === "object");
}

export class MysqlDriver implements DatabaseDriver {
	readonly engine = "mysql" as const;
	private pool: MysqlPoolLike | null = null;

	constructor(
		private readonly config: ConnectionConfig,
		private readonly poolFactory: MysqlPoolFactory = (cfg) => createPool(cfg) as unknown as MysqlPoolLike,
	) {}

	async connect(): Promise<void> {
		if (this.pool) {
			return;
		}
		this.pool = this.poolFactory(toPoolOptions(this.config));
	}

	async disconnect(): Promise<void> {
		await this.pool?.end();
		this.pool = null;
	}

	private require(): MysqlPoolLike {
		if (!this.pool) {
			throw new DbConnectionError("mysql driver is not connected");
		}
		return this.pool;
	}

	async testConnection(): Promise<TestConnectionResult> {
		const started = performance.now();
		const [rows] = await this.require().query("SELECT VERSION() AS v");
		const version = isRowArray(rows) ? ((rows[0]?.v as string | undefined) ?? null) : null;
		return { ok: true, latencyMs: performance.now() - started, serverVersion: version };
	}

	async query(request: QueryRequest): Promise<QueryResult> {
		const pool = this.require();
		const started = performance.now();
		const params = request.params ? [...request.params] : undefined;
		if (request.readOnly) {
			const conn = await pool.getConnection();
			try {
				await conn.query("START TRANSACTION READ ONLY");
				const [rows, fields] = await conn.query(request.sql, params);
				await conn.query("COMMIT");
				return this.toResult(rows, fields, started);
			} catch (error) {
				try {
					await conn.query("ROLLBACK");
				} catch {
					// best-effort rollback
				}
				throw new DbQueryError(`mysql query failed: ${String(error)}`, error);
			} finally {
				conn.release();
			}
		}
		try {
			const [rows, fields] = await pool.query(request.sql, params);
			return this.toResult(rows, fields, started);
		} catch (error) {
			throw new DbQueryError(`mysql query failed: ${String(error)}`, error);
		}
	}

	private toResult(rows: unknown, fields: FieldPacketLike[] | undefined, started: number): QueryResult {
		if (isRowArray(rows)) {
			return {
				rows,
				fields: (fields ?? []).map((f) => ({ name: f.name, dataTypeId: f.columnType })),
				rowCount: rows.length,
				durationMs: performance.now() - started,
			};
		}
		// Write result (ResultSetHeader): no rows; report affectedRows.
		const affected = (rows as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
		return { rows: [], fields: [], rowCount: affected, durationMs: performance.now() - started };
	}

	async introspect(): Promise<SchemaIntrospection> {
		const pool = this.require();
		const sql = `
			SELECT c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type,
			       c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
			       c.COLUMN_DEFAULT AS column_default, (c.COLUMN_KEY = 'PRI') AS is_primary_key
			FROM information_schema.COLUMNS c
			JOIN information_schema.TABLES t
			  ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
			WHERE c.TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
			ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`;
		const [rows] = await pool.query(sql);
		const tables = isRowArray(rows) ? groupColumnsIntoTables(rows) : [];
		log.debug("mysql introspect complete", { tableCount: tables.length });
		return { engine: this.engine, tables };
	}
}

interface FlatColumnRow {
	table_schema: string;
	table_name: string;
	table_type: string;
	column_name: string;
	data_type: string;
	is_nullable: string;
	column_default: string | null;
	is_primary_key: number | boolean;
}

function groupColumnsIntoTables(rows: Row[]): TableInfo[] {
	const byTable = new Map<string, TableInfo>();
	for (const raw of rows as unknown as FlatColumnRow[]) {
		const key = `${raw.table_schema}.${raw.table_name}`;
		let table = byTable.get(key);
		if (!table) {
			table = {
				schema: raw.table_schema,
				name: raw.table_name,
				kind: raw.table_type === "VIEW" ? "view" : "table",
				columns: [],
			};
			byTable.set(key, table);
		}
		const column: ColumnInfo = {
			name: raw.column_name,
			dataType: raw.data_type,
			nullable: raw.is_nullable === "YES",
			isPrimaryKey: raw.is_primary_key === 1 || raw.is_primary_key === true,
			defaultValue: raw.column_default,
		};
		table.columns.push(column);
	}
	return [...byTable.values()];
}

registerDriver("mysql", (config) => new MysqlDriver(config));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/mysql-driver.test.ts --exclude='**/.kanban/**'`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit** (only if commits authorized)

```bash
git add src/db/driver/mysql-driver.ts test/runtime/db/mysql-driver.test.ts
git commit -m "feat(db): add MySQL/MariaDB driver adapter (mysql2)"
```

---

### Task 9: Pool manager

**Files:**
- Create: `src/db/pool/pool-manager.ts`
- Test: `test/runtime/db/pool-manager.test.ts`

**Interfaces:**
- Consumes: `DatabaseDriver` from `../driver/driver`; `createDriver` from `../driver/driver-registry`; `ConnectionConfig` from `../types`.
- Produces:
  - `interface PoolManagerOptions { idleTimeoutMs?: number; now?: () => number; createDriver?: (config) => DatabaseDriver }`
  - `class PoolManager` with: `getDriver(connId, config): Promise<DatabaseDriver>`, `invalidate(connId): Promise<void>`, `reapIdle(): Promise<void>`, `disposeAll(): Promise<void>`, `size(): number`.

- [ ] **Step 1: Write the failing test `test/runtime/db/pool-manager.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import type { DatabaseDriver } from "../../../src/db/driver/driver";
import { PoolManager } from "../../../src/db/pool/pool-manager";
import type { ConnectionConfig } from "../../../src/db/types";

function makeDriver(): DatabaseDriver & { connects: number; disconnects: number } {
	const state = { connects: 0, disconnects: 0 };
	return {
		engine: "sqlite",
		connects: 0,
		disconnects: 0,
		connect: async () => {
			state.connects += 1;
			(driver as { connects: number }).connects = state.connects;
		},
		disconnect: async () => {
			state.disconnects += 1;
			(driver as { disconnects: number }).disconnects = state.disconnects;
		},
		testConnection: async () => ({ ok: true, latencyMs: 0, serverVersion: null }),
		query: async () => ({ rows: [], fields: [], rowCount: 0, durationMs: 0 }),
		introspect: async () => ({ engine: "sqlite", tables: [] }),
	} as DatabaseDriver & { connects: number; disconnects: number };
}

const config: ConnectionConfig = { engine: "sqlite", filePath: "/tmp/x.db" };

describe("PoolManager", () => {
	it("creates a driver once and reuses it", async () => {
		const driver = makeDriver();
		const mgr = new PoolManager({ createDriver: () => driver });
		const a = await mgr.getDriver("c1", config);
		const b = await mgr.getDriver("c1", config);
		expect(a).toBe(b);
		expect(driver.connects).toBe(1);
		expect(mgr.size()).toBe(1);
	});

	it("de-dupes concurrent first-use connect calls", async () => {
		const driver = makeDriver();
		const mgr = new PoolManager({ createDriver: () => driver });
		const [a, b] = await Promise.all([mgr.getDriver("c1", config), mgr.getDriver("c1", config)]);
		expect(a).toBe(b);
		expect(driver.connects).toBe(1);
	});

	it("invalidate disconnects and evicts", async () => {
		const driver = makeDriver();
		const mgr = new PoolManager({ createDriver: () => driver });
		await mgr.getDriver("c1", config);
		await mgr.invalidate("c1");
		expect(driver.disconnects).toBe(1);
		expect(mgr.size()).toBe(0);
	});

	it("reapIdle evicts drivers idle past the timeout using the injected clock", async () => {
		let nowMs = 1000;
		const driver = makeDriver();
		const mgr = new PoolManager({ createDriver: () => driver, idleTimeoutMs: 500, now: () => nowMs });
		await mgr.getDriver("c1", config);
		nowMs = 1200; // within timeout
		await mgr.reapIdle();
		expect(mgr.size()).toBe(1);
		nowMs = 1700; // past timeout
		await mgr.reapIdle();
		expect(mgr.size()).toBe(0);
		expect(driver.disconnects).toBe(1);
	});

	it("disposeAll disconnects every driver", async () => {
		const d1 = makeDriver();
		const d2 = makeDriver();
		const drivers = [d1, d2];
		let i = 0;
		const mgr = new PoolManager({ createDriver: () => drivers[i++] });
		await mgr.getDriver("c1", config);
		await mgr.getDriver("c2", config);
		await mgr.disposeAll();
		expect(d1.disconnects).toBe(1);
		expect(d2.disconnects).toBe(1);
		expect(mgr.size()).toBe(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/pool-manager.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — cannot resolve the pool-manager module.

- [ ] **Step 3: Write `src/db/pool/pool-manager.ts`**

```ts
import { createLogger } from "../../logging";
import type { DatabaseDriver } from "../driver/driver";
import { createDriver as defaultCreateDriver } from "../driver/driver-registry";
import type { ConnectionConfig } from "../types";

const log = createLogger("db:pool-manager");

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface PoolEntry {
	driver: DatabaseDriver;
	lastUsedAt: number;
}

export interface PoolManagerOptions {
	/** Evict + disconnect drivers idle longer than this. Default 5 minutes. */
	idleTimeoutMs?: number;
	/** Injectable clock (ms). Defaults to Date.now. Tests inject a fake. */
	now?: () => number;
	/** Injectable driver factory. Defaults to the engine registry. Tests inject a fake. */
	createDriver?: (config: ConnectionConfig) => DatabaseDriver;
}

/**
 * Process-level manager of one live {@link DatabaseDriver} per connection id. Connects
 * lazily on first use, reuses the driver across queries, de-dupes concurrent first-use,
 * and reclaims idle drivers. Never one-connection-per-query.
 */
export class PoolManager {
	private readonly entries = new Map<string, PoolEntry>();
	private readonly pending = new Map<string, Promise<DatabaseDriver>>();
	private readonly idleTimeoutMs: number;
	private readonly now: () => number;
	private readonly createDriver: (config: ConnectionConfig) => DatabaseDriver;

	constructor(options: PoolManagerOptions = {}) {
		this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
		this.createDriver = options.createDriver ?? defaultCreateDriver;
	}

	/** Get (or lazily create + connect) the driver for a connection id. */
	async getDriver(connId: string, config: ConnectionConfig): Promise<DatabaseDriver> {
		const existing = this.entries.get(connId);
		if (existing) {
			existing.lastUsedAt = this.now();
			return existing.driver;
		}
		const inFlight = this.pending.get(connId);
		if (inFlight) {
			return inFlight;
		}
		const promise = (async () => {
			const driver = this.createDriver(config);
			await driver.connect();
			this.entries.set(connId, { driver, lastUsedAt: this.now() });
			return driver;
		})();
		this.pending.set(connId, promise);
		try {
			return await promise;
		} finally {
			this.pending.delete(connId);
		}
	}

	/** Disconnect + drop the driver for a connection id (call after a registry edit/delete). */
	async invalidate(connId: string): Promise<void> {
		const entry = this.entries.get(connId);
		if (!entry) {
			return;
		}
		this.entries.delete(connId);
		await this.safeDisconnect(connId, entry.driver);
	}

	/** Evict + disconnect drivers idle past the timeout. */
	async reapIdle(): Promise<void> {
		const cutoff = this.now() - this.idleTimeoutMs;
		const stale = [...this.entries.entries()].filter(([, entry]) => entry.lastUsedAt < cutoff);
		for (const [connId, entry] of stale) {
			this.entries.delete(connId);
			await this.safeDisconnect(connId, entry.driver);
		}
	}

	/** Disconnect + drop every driver (runtime shutdown). */
	async disposeAll(): Promise<void> {
		const all = [...this.entries.entries()];
		this.entries.clear();
		for (const [connId, entry] of all) {
			await this.safeDisconnect(connId, entry.driver);
		}
	}

	size(): number {
		return this.entries.size;
	}

	private async safeDisconnect(connId: string, driver: DatabaseDriver): Promise<void> {
		try {
			await driver.disconnect();
		} catch (error) {
			log.warn("driver disconnect failed", { connId, error });
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/pool-manager.test.ts --exclude='**/.kanban/**'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit** (only if commits authorized)

```bash
git add src/db/pool/pool-manager.ts test/runtime/db/pool-manager.test.ts
git commit -m "feat(db): add per-connection pool manager with idle reclaim"
```

---

### Task 10: DatabaseService façade + public barrel

**Files:**
- Create: `src/db/db-service.ts`
- Create: `src/db/index.ts`
- Test: `test/runtime/db/db-service.test.ts`

**Interfaces:**
- Consumes: `PoolManager` from `./pool/pool-manager`; `assertOperationAllowed` from `./policy/access-policy`; `ConnectionRecord`, `DbCredential`, `resolveConnectionConfig` from `./registry/connection-store`; `CredentialNotConfiguredError` from `./errors`; types from `./types`. Imports the three adapter modules for their `registerDriver` side effects.
- Produces:
  - `interface DbServiceDeps { poolManager: PoolManager; loadConnection: (connId: string) => Promise<ConnectionRecord | null>; loadCredential: (connId: string) => Promise<DbCredential | undefined> }`
  - `class DatabaseService` with: `testConnection(connId)`, `runQuery({ connId, sql, caller, params? })`, `introspect({ connId, caller })`, `invalidate(connId)`.
- The barrel `src/db/index.ts` re-exports the public surface (types, errors, `DatabaseService`, `PoolManager`, registry store fns, policy fns) AND imports the adapter modules so registration happens when anything imports `src/db`.

- [ ] **Step 1: Write the failing test `test/runtime/db/db-service.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { DatabaseService } from "../../../src/db/db-service";
import { DbPolicyError } from "../../../src/db/errors";
import { PoolManager } from "../../../src/db/pool/pool-manager";
import type { ConnectionRecord } from "../../../src/db/registry/connection-store";
import type { DatabaseDriver } from "../../../src/db/driver/driver";
import type { QueryRequest } from "../../../src/db/types";

function record(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
	return {
		connId: "c1",
		label: "c1",
		engine: "postgres",
		host: "h",
		port: 5432,
		database: "d",
		user: "u",
		filePath: null,
		ssl: null,
		allowWrites: false,
		createdAt: "2026-06-22T00:00:00.000Z",
		...overrides,
	};
}

function fakeDriver(seen: QueryRequest[]): DatabaseDriver {
	return {
		engine: "postgres",
		connect: async () => {},
		disconnect: async () => {},
		testConnection: async () => ({ ok: true, latencyMs: 1, serverVersion: "PostgreSQL 16" }),
		query: async (req) => {
			seen.push(req);
			return { rows: [{ ok: 1 }], fields: [{ name: "ok" }], rowCount: 1, durationMs: 1 };
		},
		introspect: async () => ({ engine: "postgres", tables: [] }),
	};
}

function makeService(rec: ConnectionRecord, seen: QueryRequest[]) {
	const poolManager = new PoolManager({ createDriver: () => fakeDriver(seen) });
	return new DatabaseService({
		poolManager,
		loadConnection: async (id) => (id === rec.connId ? rec : null),
		loadCredential: async () => ({ password: "secret" }),
	});
}

describe("DatabaseService", () => {
	it("runs a read query and passes readOnly=true to the driver", async () => {
		const seen: QueryRequest[] = [];
		const svc = makeService(record(), seen);
		const result = await svc.runQuery({ connId: "c1", sql: "SELECT 1 AS ok", caller: "human" });
		expect(result.rowCount).toBe(1);
		expect(seen[0].readOnly).toBe(true);
	});

	it("blocks a write from the agent caller even when the connection allows writes", async () => {
		const seen: QueryRequest[] = [];
		const svc = makeService(record({ allowWrites: true }), seen);
		await expect(
			svc.runQuery({ connId: "c1", sql: "DELETE FROM t", caller: "agent" }),
		).rejects.toBeInstanceOf(DbPolicyError);
		expect(seen).toHaveLength(0); // never reached the driver
	});

	it("allows a write for human when the connection opts in", async () => {
		const seen: QueryRequest[] = [];
		const svc = makeService(record({ allowWrites: true }), seen);
		await svc.runQuery({ connId: "c1", sql: "DELETE FROM t", caller: "human" });
		expect(seen[0].readOnly).toBe(false);
	});

	it("throws for an unknown connection id", async () => {
		const seen: QueryRequest[] = [];
		const svc = makeService(record(), seen);
		await expect(svc.runQuery({ connId: "missing", sql: "SELECT 1", caller: "cli" })).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/db-service.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — cannot resolve the db-service module.

- [ ] **Step 3: Write `src/db/db-service.ts`**

```ts
import { createLogger } from "../logging";
import { DbConnectionError } from "./errors";
import type { PoolManager } from "./pool/pool-manager";
import { assertOperationAllowed } from "./policy/access-policy";
import type { ConnectionRecord, DbCredential } from "./registry/connection-store";
import { resolveConnectionConfig } from "./registry/connection-store";
import type { DbCaller, QueryResult, SchemaIntrospection, TestConnectionResult } from "./types";

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

	private async resolveDriver(connId: string): Promise<{ record: ConnectionRecord; driver: Awaited<ReturnType<PoolManager["getDriver"]>> }> {
		const record = await this.deps.loadConnection(connId);
		if (!record) {
			throw new DbConnectionError(`unknown connection: "${connId}"`);
		}
		const credential = await this.deps.loadCredential(connId);
		const config = resolveConnectionConfig(record, credential);
		// SQLite needs the record-level write opt-in to choose its handle mode; pass it through.
		const driver = await this.deps.poolManager.getDriver(connId, { ...config, allowWrites: record.allowWrites } as typeof config);
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
```

- [ ] **Step 4: Write `src/db/index.ts`**

```ts
// Importing the adapter modules registers their engine factories as a side effect.
import "./driver/postgres-driver";
import "./driver/mysql-driver";
import "./driver/sqlite-driver";

export * from "./types";
export * from "./errors";
export type { DatabaseDriver } from "./driver/driver";
export { createDriver, registerDriver } from "./driver/driver-registry";
export { PoolManager, type PoolManagerOptions } from "./pool/pool-manager";
export { assertOperationAllowed, type AccessPolicyInput, type ResolvedOperation } from "./policy/access-policy";
export { classifySql } from "./policy/sql-classifier";
export {
	type ConnectionRecord,
	type DbCredential,
	type DbCredentialsData,
	connectionRecordSchema,
	dbCredentialsDataSchema,
	databaseEngineSchema,
} from "./registry/connection-record";
export {
	normalizeConnId,
	readConnections,
	writeConnections,
	readCredentials,
	writeCredentials,
	resolveConnectionConfig,
} from "./registry/connection-store";
export {
	DatabaseService,
	type DbServiceDeps,
	type RunQueryInput,
	type IntrospectInput,
} from "./db-service";
```

> Note: `connectionRecordSchema`/`dbCredentialsDataSchema`/`databaseEngineSchema` are declared in `connection-record.ts` (Task 4) but were re-exported from `connection-store.ts` as types only. Add value re-exports of the schemas from `connection-store.ts` if cleaner, or import directly from `connection-record.ts` here as written. Keep imports consistent with what Task 4 actually exported.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/db-service.test.ts --exclude='**/.kanban/**'`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck the whole db module**

Run: `npm run typecheck`
Expected: no new errors under `src/db/`. (Pre-existing repo errors elsewhere, if any, are out of scope — compare against a clean baseline per the repo gotcha.)

- [ ] **Step 7: Commit** (only if commits authorized)

```bash
git add src/db/db-service.ts src/db/index.ts test/runtime/db/db-service.test.ts
git commit -m "feat(db): add DatabaseService façade and public barrel"
```

---

### Task 11: workspace-state persistence seam

**Files:**
- Modify: `src/state/workspace-state.ts` (add path helpers + load/mutate seam)
- Test: `test/runtime/db/db-connection-persistence.test.ts`

**Interfaces:**
- Consumes: `readConnections`/`writeConnections`/`readCredentials`/`writeCredentials` from `../../db/registry/connection-store`; `ConnectionRecord`/`DbCredential` from same; existing `resolveRepoPathForWorkspaceId`, `getBoardDataWorkspaceDirectoryPath` (file-private — add an exported path helper), `lockedFileSystem`, the workspace-dir lock helper used by the committed-provider seam.
- Produces (exported from `workspace-state.ts`):
  - `function getWorkspaceDbConnectionsShardDir(repoPath: string, workspaceId: string): string` (under `boardDataHome`)
  - `function getDbCredentialsPath(): string` (machine-home `~/.kanban/settings/db-credentials.json`, overridable via `KANBAN_DB_CREDENTIALS_PATH`)
  - `async function loadWorkspaceDbConnections(workspaceId: string): Promise<ConnectionRecord[]>`
  - `async function mutateWorkspaceDbConnections(workspaceId: string, mutate: (records: ConnectionRecord[]) => ConnectionRecord[] | Promise<ConnectionRecord[]>): Promise<ConnectionRecord[]>`
  - `async function loadDbCredential(connId: string): Promise<DbCredential | undefined>`
  - `async function mutateDbCredential(connId: string, mutate: (current: DbCredential | undefined) => DbCredential | undefined): Promise<void>`

**Implementation guidance:** Open `src/state/workspace-state.ts` and locate the committed-provider seam (search for `committed-provider` / `readCommittedProviders` if present, or the requirement-shard seam `getWorkspaceRequirementsShardDir`). Mirror its exact structure: resolve `repoPath` via `resolveRepoPathForWorkspaceId`, derive the shard dir under `getBoardDataWorkspaceDirectoryPath`, and hold the workspace-dir lock around read→mutate→write. For the credential file, mirror `agent-provider-config.ts`'s machine-home path resolution (`join(homedir(), ".kanban", "settings", "db-credentials.json")` with a `KANBAN_DB_CREDENTIALS_PATH` env override) — credentials are machine-local and use no repo lock.

- [ ] **Step 1: Read the committed-provider / requirement seam to copy its locking pattern**

Run: `grep -n "getWorkspaceRequirementsShardDir\|mutateWorkspace\|withWorkspaceLock\|resolveRepoPathForWorkspaceId" src/state/workspace-state.ts`
Expected: identify the lock helper name and one existing `mutateWorkspace*` function to mirror. Read those ~40 lines.

- [ ] **Step 2: Write the failing test `test/runtime/db/db-connection-persistence.test.ts`**

```ts
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getDbCredentialsPath,
	loadDbCredential,
	mutateDbCredential,
} from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";

describe("db credential persistence (machine-home)", () => {
	let prev: string | undefined;

	beforeEach(async () => {
		prev = process.env.KANBAN_DB_CREDENTIALS_PATH;
		const dir = await createTempDir();
		process.env.KANBAN_DB_CREDENTIALS_PATH = join(dir, "db-credentials.json");
	});

	afterEach(() => {
		if (prev === undefined) {
			delete process.env.KANBAN_DB_CREDENTIALS_PATH;
		} else {
			process.env.KANBAN_DB_CREDENTIALS_PATH = prev;
		}
	});

	it("resolves the overridden path", () => {
		expect(getDbCredentialsPath()).toContain("db-credentials.json");
	});

	it("round-trips a credential", async () => {
		await mutateDbCredential("c1", () => ({ password: "secret" }));
		expect((await loadDbCredential("c1"))?.password).toBe("secret");
	});

	it("deletes a credential when the mutator returns undefined", async () => {
		await mutateDbCredential("c1", () => ({ password: "secret" }));
		await mutateDbCredential("c1", () => undefined);
		expect(await loadDbCredential("c1")).toBeUndefined();
	});
});
```

> The connection-record persistence (`loadWorkspaceDbConnections`/`mutateWorkspaceDbConnections`) is exercised end-to-end by the existing workspace-context integration tests once wired; this focused test covers the new machine-home credential seam, which is the genuinely new persistence behavior. If a lightweight repo fixture helper exists (search `test/` for how `committed-provider-store` persistence is integration-tested), add an analogous round-trip for the connection shards.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun vitest run test/runtime/db/db-connection-persistence.test.ts --exclude='**/.kanban/**'`
Expected: FAIL — the new exports don't exist yet.

- [ ] **Step 4: Add the path helpers + seam to `src/state/workspace-state.ts`**

Add imports at the top (with the other `db`/state imports):

```ts
import {
	type ConnectionRecord,
	type DbCredential,
	readConnections,
	writeConnections,
	readCredentials,
	writeCredentials,
} from "../db/registry/connection-store";
```

Add path helpers near the other `getWorkspace*ShardDir` helpers:

```ts
const DB_CONNECTIONS_SHARD_DIRNAME = "db-connections";

/** Committed (board-data) per-connection metadata shard dir. Travels with the repo. */
export function getWorkspaceDbConnectionsShardDir(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), DB_CONNECTIONS_SHARD_DIRNAME);
}

/** Machine-home DB credentials file (secrets only; never committed). */
export function getDbCredentialsPath(): string {
	const override = process.env.KANBAN_DB_CREDENTIALS_PATH?.trim();
	if (override) {
		return override;
	}
	return join(getMachineKanbanHomePath(), "settings", "db-credentials.json");
}
```

Add the load/mutate functions, mirroring the existing locked `mutateWorkspace*` seam you read in Step 1 (substitute the real lock helper name + repo-path resolution found there):

```ts
/** Load all committed DB connection records for a workspace. */
export async function loadWorkspaceDbConnections(workspaceId: string): Promise<ConnectionRecord[]> {
	const repoPath = await resolveRepoPathForWorkspaceId(workspaceId);
	if (!repoPath) {
		return [];
	}
	return readConnections(getWorkspaceDbConnectionsShardDir(repoPath, workspaceId));
}

/** Locked read→mutate→write of a workspace's committed DB connection records. */
export async function mutateWorkspaceDbConnections(
	workspaceId: string,
	mutate: (records: ConnectionRecord[]) => ConnectionRecord[] | Promise<ConnectionRecord[]>,
): Promise<ConnectionRecord[]> {
	const repoPath = await resolveRepoPathForWorkspaceId(workspaceId);
	if (!repoPath) {
		throw new Error(`cannot resolve repo path for workspace ${workspaceId}`);
	}
	const shardDir = getWorkspaceDbConnectionsShardDir(repoPath, workspaceId);
	// Use the SAME workspace-dir lock wrapper the committed-provider/requirement seam uses.
	return withWorkspaceDirectoryLock(repoPath, workspaceId, async () => {
		const current = await readConnections(shardDir);
		const next = await mutate(current);
		await writeConnections(shardDir, next);
		return next;
	});
}

/** Load one machine-home credential by connection id. */
export async function loadDbCredential(connId: string): Promise<DbCredential | undefined> {
	const data = await readCredentials(getDbCredentialsPath());
	return data.credentials[connId];
}

/** Read→mutate→write one machine-home credential (machine-local; no repo lock). */
export async function mutateDbCredential(
	connId: string,
	mutate: (current: DbCredential | undefined) => DbCredential | undefined,
): Promise<void> {
	const path = getDbCredentialsPath();
	const data = await readCredentials(path);
	const next = mutate(data.credentials[connId]);
	if (next === undefined) {
		delete data.credentials[connId];
	} else {
		data.credentials[connId] = next;
	}
	await writeCredentials(path, data);
}
```

> `withWorkspaceDirectoryLock` is a placeholder for the actual lock wrapper name in this file — replace it with the real one found in Step 1 (e.g. the helper the committed-provider seam calls). If `writeCredentials` needs the settings dir to exist, mkdir it as `agent-provider-config.ts` does (check that file's write path).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun vitest run test/runtime/db/db-connection-persistence.test.ts --exclude='**/.kanban/**'`
Expected: PASS (3 tests).

- [ ] **Step 6: Full typecheck + db test sweep**

Run:
```bash
npm run typecheck
bun vitest run test/runtime/db --exclude='**/.kanban/**'
```
Expected: typecheck clean for `src/db` + `src/state/workspace-state.ts`; all `test/runtime/db/*` pass.

- [ ] **Step 7: Lint**

Run: `npx @biomejs/biome check src/db test/runtime/db`
Expected: clean (fix any formatting with `npx @biomejs/biome check --write src/db test/runtime/db`).

- [ ] **Step 8: Commit** (only if commits authorized)

```bash
git add src/state/workspace-state.ts test/runtime/db/db-connection-persistence.test.ts
git commit -m "feat(db): wire DB connection + credential persistence into workspace-state"
```

---

## Self-Review

**1. Spec coverage:**
- Driver interface + 3 adapters → Tasks 5/6/7/8 ✓
- Connection registry, two-root secret boundary → Tasks 4 + 11 ✓
- Connection pool, reuse + idle reclaim → Task 9 ✓
- Central security policy (default RO, connection write opt-in, agent always RO) → Tasks 2/3 + chokepoint enforced in Task 10 ✓
- Defense-in-depth (classifier + DB-level RO session) → Task 3 (classifier/policy) + Tasks 6/7/8 (driver RO session) ✓
- No `console.*` / `createLogger` / no `any` / SDK types → Global Constraints + applied per task ✓
- "No upper entry points" → plan stops at the service façade + persistence seam; no UI/MCP/CLI ✓

**2. Placeholder scan:** The only intentional "fill in the real name" spots are the lock-helper name and the committed-provider seam location in Task 11, which require reading the live file (Step 1 does that). All code blocks are complete and runnable. SQLite `allowWrites`-on-config carry-through is documented in Tasks 6 and 10.

**3. Type consistency:** `ConnectionRecord`, `ConnectionConfig`, `QueryRequest`, `QueryResult`, `SchemaIntrospection`, `DbCaller`, `assertOperationAllowed`, `resolveConnectionConfig`, `PoolManager.getDriver`, `createDriver`, `registerDriver` names are used identically across tasks. The `allowWrites`-extra-on-config pattern is consistently described (record-level concept, passed through at the `db-service`/sqlite boundary, never added to shared `ConnectionConfig`).

## Known Risks / Implementation Notes

- **`better-sqlite3` native build** (Task 6): if it fails in the dev/runtime environment, STOP and report; the driver-registry design allows swapping to Node's built-in `node:sqlite` without touching any caller. This is the one flagged risk.
- **node-sql-parser dialect coverage** (Task 2): some valid statements may not parse and classify as `unknown` → blocked for read-only callers. Acceptable for the foundation; an allow-list refinement can come later. The fail-closed direction is deliberate.
- **Real Postgres/MySQL integration tests** are intentionally out of scope (no CI DB servers). Adapters are unit-tested via injected fake pools; a gated integration test (skipped by default, like `test:proxy-live`) can be added later when a local server is available.
- **Pool idle-reap scheduling**: Task 9 provides `reapIdle()`; wiring a periodic timer + `disposeAll()` into the runtime lifecycle is a one-line hookup left for whichever upper-entry task first instantiates a process-level `PoolManager` (no process-level singleton is created in this foundation by design — the service receives its `PoolManager` via deps so tests stay hermetic).
