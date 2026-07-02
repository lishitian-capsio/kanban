import { describe, expect, it } from "vitest";

import { DatabaseService } from "../../../src/db/db-service";
import type { DatabaseDriver } from "../../../src/db/driver/driver";
import { IntrospectionCache } from "../../../src/db/introspection/introspection-cache";
import { QueryExecutionError } from "../../../src/db/execution/query-error-normalizer";
import { QueryExecutor } from "../../../src/db/execution/query-executor";
import { createQueryConcurrencyLimiter } from "../../../src/db/execution/query-limiter";
import { PoolManager } from "../../../src/db/pool/pool-manager";
import type { ConnectionRecord } from "../../../src/db/registry/connection-store";
import type { FieldInfo, QueryRequest } from "../../../src/db/types";

interface FakeDriverController {
	rows: Array<Record<string, unknown>>;
	fields: FieldInfo[];
	rowCount: number;
	durationMs: number;
	hang: boolean;
	seen: QueryRequest[];
	disconnectCount: number;
	/** When true, describeTable reports no primary key (forces the OFFSET browse fallback). */
	noPk: boolean;
}

function controller(overrides: Partial<FakeDriverController> = {}): FakeDriverController {
	return {
		rows: [{ ok: 1 }],
		fields: [{ name: "ok" }],
		rowCount: 1,
		durationMs: 3,
		hang: false,
		seen: [],
		disconnectCount: 0,
		noPk: false,
		...overrides,
	};
}

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

function fakeDriver(ctrl: FakeDriverController): DatabaseDriver {
	return {
		engine: "postgres",
		connect: async () => {},
		disconnect: async () => {
			ctrl.disconnectCount++;
		},
		testConnection: async () => ({ ok: true, latencyMs: 1, serverVersion: "PostgreSQL 16" }),
		query: async (req) => {
			ctrl.seen.push(req);
			if (ctrl.hang) {
				await new Promise<never>(() => {});
			}
			return { rows: ctrl.rows, fields: ctrl.fields, rowCount: ctrl.rowCount, durationMs: ctrl.durationMs };
		},
		introspect: async () => ({ engine: "postgres", tables: [] }),
		listSchemas: async () => [{ name: "public" }],
		listTables: async (schema) => [{ schema, name: "t", kind: "table" as const }],
		describeTable: async (schema, table) => ({
			schema,
			name: table,
			kind: "table" as const,
			columns: [
				{ name: "id", dataType: "int8", nullable: false, isPrimaryKey: !ctrl.noPk, defaultValue: null },
				{ name: "a", dataType: "int4", nullable: true, isPrimaryKey: false, defaultValue: null },
			],
			indexes: [],
			foreignKeys: [],
		}),
		metadataSignature: async () => "const",
	};
}

function makeExecutor(
	rec: ConnectionRecord,
	ctrl: FakeDriverController,
	limits?: ConstructorParameters<typeof QueryExecutor>[0]["limits"],
) {
	const poolManager = new PoolManager({ createDriver: () => fakeDriver(ctrl) });
	const loadConnection = async (id: string) => (id === rec.connId ? rec : null);
	const service = new DatabaseService({
		poolManager,
		loadConnection,
		loadCredential: async () => undefined,
		// Fresh per-executor cache so introspection results don't leak across tests via the singleton.
		introspectionCache: new IntrospectionCache(),
	});
	const executor = new QueryExecutor({ service, loadConnection, limits });
	return { executor, service };
}

describe("QueryExecutor reads", () => {
	it("wraps a read in a server-side LIMIT subquery using pageSize+1", async () => {
		const ctrl = controller({ rows: [{ a: 1 }, { a: 2 }] });
		const { executor } = makeExecutor(record(), ctrl);
		await executor.execute({ connId: "c1", sql: "SELECT a FROM t", caller: "human", page: { pageSize: 2 } });
		expect(ctrl.seen[0].sql).toBe("SELECT * FROM (SELECT a FROM t) AS _kanban_q LIMIT 3 OFFSET 0");
		expect(ctrl.seen[0].readOnly).toBe(true);
	});

	it("returns a page with a next cursor when the probe row indicates more", async () => {
		const ctrl = controller({ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }); // 3 = pageSize(2) + probe
		const { executor } = makeExecutor(record(), ctrl);
		const result = await executor.execute({
			connId: "c1",
			sql: "SELECT a FROM t",
			caller: "human",
			page: { pageSize: 2 },
		});
		expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
		expect(result.rowCount).toBe(2);
		expect(result.affectedRows).toBeNull();
		expect(result.classification).toBe("read");
		expect(result.pagination.paginated).toBe(true);
		expect(result.pagination.hasMore).toBe(true);
		expect(result.pagination.nextCursor).not.toBeNull();
	});

	it("reports no next page when the driver returns fewer than the probe limit", async () => {
		const ctrl = controller({ rows: [{ a: 1 }, { a: 2 }] });
		const { executor } = makeExecutor(record(), ctrl);
		const result = await executor.execute({
			connId: "c1",
			sql: "SELECT a FROM t",
			caller: "human",
			page: { pageSize: 2 },
		});
		expect(result.pagination.hasMore).toBe(false);
		expect(result.pagination.nextCursor).toBeNull();
	});

	it("clamps the requested page size to the row cap", async () => {
		const ctrl = controller({ rows: [{ a: 1 }] });
		const { executor } = makeExecutor(record(), ctrl, { maxRows: 10 });
		await executor.execute({ connId: "c1", sql: "SELECT a FROM t", caller: "human", page: { pageSize: 1000 } });
		expect(ctrl.seen[0].sql).toContain("LIMIT 11 OFFSET 0");
	});

	it("resumes from a supplied cursor", async () => {
		const ctrl = controller({ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] });
		const { executor } = makeExecutor(record(), ctrl);
		const first = await executor.execute({
			connId: "c1",
			sql: "SELECT a FROM t",
			caller: "human",
			page: { pageSize: 2 },
		});
		await executor.execute({
			connId: "c1",
			sql: "SELECT a FROM t",
			caller: "human",
			page: { pageSize: 2, cursor: first.pagination.nextCursor },
		});
		expect(ctrl.seen[1].sql).toContain("LIMIT 3 OFFSET 2");
	});

	it("truncates a page by the byte cap", async () => {
		const big = "x".repeat(2000);
		const ctrl = controller({ rows: [{ a: big }, { a: big }, { a: big }] });
		const { executor } = makeExecutor(record(), ctrl, { maxBytes: 2500 });
		const result = await executor.execute({
			connId: "c1",
			sql: "SELECT a FROM t",
			caller: "human",
			page: { pageSize: 10 },
		});
		expect(result.truncated.byBytes).toBe(true);
		expect(result.rows.length).toBeLessThan(3);
		expect(result.pagination.hasMore).toBe(true);
	});

	it("reports the driver's execution time", async () => {
		const ctrl = controller({ durationMs: 42 });
		const { executor } = makeExecutor(record(), ctrl);
		const result = await executor.execute({ connId: "c1", sql: "SELECT 1", caller: "human" });
		expect(result.durationMs).toBe(42);
		expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
	});
});

describe("QueryExecutor writes & policy", () => {
	it("passes a write through unwrapped and reports affected rows", async () => {
		const ctrl = controller({ rows: [], fields: [], rowCount: 5 });
		const { executor } = makeExecutor(record({ allowWrites: true }), ctrl);
		const result = await executor.execute({ connId: "c1", sql: "UPDATE t SET x = 1", caller: "human" });
		expect(ctrl.seen[0].sql).toBe("UPDATE t SET x = 1");
		expect(ctrl.seen[0].readOnly).toBe(false);
		expect(result.classification).toBe("write");
		expect(result.affectedRows).toBe(5);
		expect(result.pagination.paginated).toBe(false);
	});

	it("normalizes a policy denial (agent write) into a structured error", async () => {
		const ctrl = controller();
		const { executor } = makeExecutor(record({ allowWrites: true }), ctrl);
		const error = await executor.execute({ connId: "c1", sql: "DELETE FROM t", caller: "agent" }).catch((e) => e);
		expect(error).toBeInstanceOf(QueryExecutionError);
		expect((error as QueryExecutionError).normalized.code).toBe("policy_denied");
		expect(ctrl.seen).toHaveLength(0); // never reached the driver
	});

	it("normalizes an unknown connection into a connection_failed error", async () => {
		const ctrl = controller();
		const { executor } = makeExecutor(record(), ctrl);
		const error = await executor.execute({ connId: "missing", sql: "SELECT 1", caller: "human" }).catch((e) => e);
		expect((error as QueryExecutionError).normalized.code).toBe("connection_failed");
	});
});

describe("QueryExecutor timeout & cancellation", () => {
	it("times out a runaway query and tears down the connection", async () => {
		const ctrl = controller({ hang: true });
		const { executor } = makeExecutor(record(), ctrl, { timeoutMs: 20 });
		const error = await executor.execute({ connId: "c1", sql: "SELECT 1", caller: "human" }).catch((e) => e);
		expect((error as QueryExecutionError).normalized.code).toBe("timeout");
		// the runaway connection's driver was disconnected (invalidated) so the runtime is not hung
		await new Promise((r) => setTimeout(r, 5));
		expect(ctrl.disconnectCount).toBe(1);
	});

	it("cancels via an abort signal", async () => {
		const ctrl = controller({ hang: true });
		const { executor } = makeExecutor(record(), ctrl);
		const ac = new AbortController();
		const promise = executor.execute({ connId: "c1", sql: "SELECT 1", caller: "human", signal: ac.signal });
		ac.abort();
		const error = await promise.catch((e) => e);
		expect((error as QueryExecutionError).normalized.code).toBe("cancelled");
	});
});

describe("QueryExecutor concurrency", () => {
	it("funnels execution through the injected limiter", async () => {
		const ctrl = controller();
		const poolManager = new PoolManager({ createDriver: () => fakeDriver(ctrl) });
		const loadConnection = async (id: string) => (id === "c1" ? record() : null);
		const service = new DatabaseService({ poolManager, loadConnection, loadCredential: async () => undefined });
		const seenConnIds: string[] = [];
		const inner = createQueryConcurrencyLimiter({ hostConcurrency: 4, perConnectionConcurrency: 4 });
		const limiter = {
			...inner,
			run: <T>(connId: string, fn: () => Promise<T>) => {
				seenConnIds.push(connId);
				return inner.run(connId, fn);
			},
		};
		const executor = new QueryExecutor({ service, loadConnection, limiter });
		await executor.execute({ connId: "c1", sql: "SELECT 1", caller: "human" });
		expect(seenConnIds).toEqual(["c1"]);
	});
});

describe("QueryExecutor.browseTable (keyset pagination)", () => {
	it("first page: keyset ORDER BY pk with no WHERE, probe LIMIT, keyset next cursor", async () => {
		const ctrl = controller({ rows: [{ id: 1, a: 9 }, { id: 2, a: 8 }, { id: 3, a: 7 }] }); // 3 = pageSize(2)+probe
		const { executor } = makeExecutor(record(), ctrl);
		const result = await executor.browseTable({
			connId: "c1",
			schema: "public",
			table: "t",
			caller: "human",
			page: { pageSize: 2 },
		});
		expect(ctrl.seen[0].sql).toBe('SELECT * FROM "public"."t" ORDER BY "id" ASC LIMIT 3');
		expect(ctrl.seen[0].params).toEqual([]);
		expect(ctrl.seen[0].readOnly).toBe(true);
		expect(result.rows).toEqual([{ id: 1, a: 9 }, { id: 2, a: 8 }]);
		expect(result.pagination.hasMore).toBe(true);
		expect(result.pagination.nextCursor).not.toBeNull();
		expect(result.readOnly).toBe(true);
		expect(result.affectedRows).toBeNull();
	});

	it("resumes after the cursor with a keyset WHERE predicate bound as a param", async () => {
		const first = controller({ rows: [{ id: 1, a: 9 }, { id: 2, a: 8 }, { id: 3, a: 7 }] });
		const { executor } = makeExecutor(record(), first);
		const page1 = await executor.browseTable({ connId: "c1", schema: "public", table: "t", caller: "human", page: { pageSize: 2 } });

		const second = controller({ rows: [{ id: 3, a: 7 }] });
		const { executor: exec2 } = makeExecutor(record(), second);
		await exec2.browseTable({
			connId: "c1",
			schema: "public",
			table: "t",
			caller: "human",
			page: { pageSize: 2, cursor: page1.pagination.nextCursor },
		});
		expect(second.seen[0].sql).toBe('SELECT * FROM "public"."t" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 3');
		expect(second.seen[0].params).toEqual([2]); // last id of page 1
	});

	it("falls back to OFFSET (deterministic order) when the table has no primary key", async () => {
		const ctrl = controller({ noPk: true, rows: [{ id: 1, a: 9 }, { id: 2, a: 8 }, { id: 3, a: 7 }] });
		const { executor } = makeExecutor(record(), ctrl);
		const page1 = await executor.browseTable({ connId: "c1", schema: "public", table: "t", caller: "human", page: { pageSize: 2 } });
		expect(ctrl.seen[0].sql).toBe('SELECT * FROM "public"."t" ORDER BY "id" ASC LIMIT 3 OFFSET 0');
		expect(page1.pagination.hasMore).toBe(true);

		const next = controller({ noPk: true, rows: [{ id: 3, a: 7 }] });
		const { executor: exec2 } = makeExecutor(record(), next);
		await exec2.browseTable({
			connId: "c1",
			schema: "public",
			table: "t",
			caller: "human",
			page: { pageSize: 2, cursor: page1.pagination.nextCursor },
		});
		expect(next.seen[0].sql).toBe('SELECT * FROM "public"."t" ORDER BY "id" ASC LIMIT 3 OFFSET 2');
	});

	it("rejects a keyset cursor handed to the OFFSET-fallback table (and vice versa)", async () => {
		// keyset cursor from a PK table...
		const pk = controller({ rows: [{ id: 1, a: 9 }, { id: 2, a: 8 }, { id: 3, a: 7 }] });
		const { executor } = makeExecutor(record(), pk);
		const keysetPage = await executor.browseTable({ connId: "c1", schema: "public", table: "t", caller: "human", page: { pageSize: 2 } });

		// ...handed to a no-PK table must be rejected, not silently restarted.
		const noPk = controller({ noPk: true });
		const { executor: exec2 } = makeExecutor(record(), noPk);
		await expect(
			exec2.browseTable({ connId: "c1", schema: "public", table: "t", caller: "human", page: { pageSize: 2, cursor: keysetPage.pagination.nextCursor } }),
		).rejects.toBeInstanceOf(QueryExecutionError);
	});
});

describe("QueryExecutor.browseTable (redis keyspace)", () => {
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

	it("scanCursor=0 terminates pagination (hasMore false, nextCursor null, no restart loop)", async () => {
		// When SCAN returns cursor "0", iteration is complete. The executor must NOT emit a non-null
		// nextCursor, as that would cause the caller to restart from the top of the keyspace.
		const service = {
			browseKeyspace: async () => ({
				rows: [{ key: "user:1", type: "string", ttl: -1, value: "x" }],
				scanCursor: "0",
				durationMs: 1,
			}),
			runQuery: async () => { throw new Error("should not be called for redis"); },
			invalidate: async () => {},
			describeTable: async () => { throw new Error("nope"); },
		} as never;
		const executor = new QueryExecutor({ service, loadConnection: async () => ({ engine: "redis", connId: "c" } as never) });
		const r = await executor.browseTable({ connId: "c", schema: "db0", table: "user", caller: "human" });
		expect(r.rows[0].key).toBe("user:1");
		expect(r.pagination.hasMore).toBe(false);
		expect(r.pagination.nextCursor).toBeNull();
		expect(r.truncated.byBytes).toBe(false);
		expect(r.truncated.byRows).toBe(false);
	});
});
