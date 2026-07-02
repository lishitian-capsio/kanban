import { describe, expect, it } from "vitest";

import type { BunSqlLike, BunSqlRows } from "../../../src/db/driver/bun-sql/bun-sql";
import { BunSqlDriver } from "../../../src/db/driver/bun-sql/bun-sql-driver";
import { postgresDialect } from "../../../src/db/driver/bun-sql/postgres-dialect";
import { DbQueryError } from "../../../src/db/errors";
import type { ConnectionConfig } from "../../../src/db/types";

interface RecordedCall {
	sql: string;
	values?: unknown[];
}

/** Tag a Bun.SQL-style result array with the `count`/`command` metadata Bun attaches. */
function rows(objs: Array<Record<string, unknown>>, command = "SELECT"): BunSqlRows {
	const result = objs as BunSqlRows;
	result.count = objs.length;
	result.command = command;
	return result;
}

/**
 * A fake Bun.SQL client that records every statement. Reads resolve to a canned row; anything
 * else (BEGIN/COMMIT/SET/write) resolves empty. `reserve()` returns a client wrapping the same
 * recorder so the read-only transaction path is fully observable.
 */
function fakeSql(): { sql: BunSqlLike; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const run = async (sql: string, values?: unknown[]): Promise<BunSqlRows> => {
		calls.push({ sql, values });
		if (sql === "SELECT version() AS v") {
			return rows([{ v: "PostgreSQL 16.0" }]);
		}
		if (sql.startsWith("SELECT")) {
			return rows([{ one: 1 }]);
		}
		return rows([], "COMMIT");
	};
	const sql: BunSqlLike = {
		unsafe: run,
		reserve: async () => ({ unsafe: run, release: () => {} }),
		connect: async () => sql,
		close: async () => {},
	};
	return { sql, calls };
}

const config: ConnectionConfig = { engine: "postgres", host: "h", database: "d", user: "u" };

function driver(sql: BunSqlLike): BunSqlDriver {
	return new BunSqlDriver(config, postgresDialect, () => sql);
}

describe("BunSqlDriver (postgres)", () => {
	it("wraps a read query in a READ ONLY transaction", async () => {
		const { sql, calls } = fakeSql();
		const d = driver(sql);
		await d.connect();
		const result = await d.query({ sql: "SELECT 1 AS one", readOnly: true });
		expect(result.rows).toEqual([{ one: 1 }]);
		expect(result.fields[0].name).toBe("one");
		const texts = calls.map((c) => c.sql);
		expect(texts).toContain("BEGIN TRANSACTION READ ONLY");
		expect(texts).toContain("COMMIT");
		await d.disconnect();
	});

	it("applies a transaction-scoped server-side statement_timeout for a read with a deadline", async () => {
		const { sql, calls } = fakeSql();
		const d = driver(sql);
		await d.connect();
		await d.query({ sql: "SELECT 1 AS one", readOnly: true, timeoutMs: 1500 });
		const texts = calls.map((c) => c.sql);
		expect(texts).toContain("SET LOCAL statement_timeout = 1500");
		expect(texts.indexOf("SET LOCAL statement_timeout = 1500")).toBeGreaterThan(
			texts.indexOf("BEGIN TRANSACTION READ ONLY"),
		);
		await d.disconnect();
	});

	it("omits the statement_timeout when no deadline (or a non-positive one) is given", async () => {
		const { sql, calls } = fakeSql();
		const d = driver(sql);
		await d.connect();
		await d.query({ sql: "SELECT 1 AS one", readOnly: true });
		await d.query({ sql: "SELECT 1 AS one", readOnly: true, timeoutMs: 0 });
		expect(calls.some((c) => c.sql.startsWith("SET LOCAL statement_timeout"))).toBe(false);
		await d.disconnect();
	});

	it("runs a write query without the read-only transaction when readOnly is false", async () => {
		const { sql, calls } = fakeSql();
		const d = driver(sql);
		await d.connect();
		await d.query({ sql: "UPDATE t SET a = 1", readOnly: false });
		expect(calls.map((c) => c.sql)).not.toContain("BEGIN TRANSACTION READ ONLY");
		await d.disconnect();
	});

	it("reports affected rows from Bun's count for a write", async () => {
		const calls: RecordedCall[] = [];
		const run = async (text: string, values?: unknown[]): Promise<BunSqlRows> => {
			calls.push({ sql: text, values });
			const result = [] as BunSqlRows;
			result.count = 3;
			result.command = "UPDATE";
			return result;
		};
		const sql: BunSqlLike = {
			unsafe: run,
			reserve: async () => ({ unsafe: run, release: () => {} }),
			connect: async () => sql,
			close: async () => {},
		};
		const d = driver(sql);
		await d.connect();
		const result = await d.query({ sql: "UPDATE t SET a = 1", readOnly: false });
		expect(result.rowCount).toBe(3);
		expect(result.rows).toEqual([]);
		await d.disconnect();
	});

	it("testConnection reports the server version", async () => {
		const { sql } = fakeSql();
		const d = driver(sql);
		await d.connect();
		const res = await d.testConnection();
		expect(res.ok).toBe(true);
		expect(res.serverVersion).toContain("PostgreSQL");
		await d.disconnect();
	});

	it("issues ROLLBACK and releases the connection when a read-only query throws", async () => {
		const texts: string[] = [];
		let released = false;
		const run = async (sql: string): Promise<BunSqlRows> => {
			texts.push(sql);
			if (sql === "SELECT bad") {
				throw new Error("syntax error");
			}
			return [] as BunSqlRows;
		};
		const sql: BunSqlLike = {
			unsafe: run,
			reserve: async () => ({
				unsafe: run,
				release: () => {
					released = true;
				},
			}),
			connect: async () => sql,
			close: async () => {},
		};
		const d = driver(sql);
		await d.connect();
		await expect(d.query({ sql: "SELECT bad", readOnly: true })).rejects.toBeInstanceOf(DbQueryError);
		expect(texts).toContain("ROLLBACK");
		expect(released).toBe(true);
		await d.disconnect();
	});
});
