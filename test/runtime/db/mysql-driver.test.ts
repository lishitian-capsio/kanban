import { describe, expect, it } from "vitest";

import type { BunSqlLike, BunSqlRows } from "../../../src/db/driver/bun-sql/bun-sql";
import { BunSqlDriver } from "../../../src/db/driver/bun-sql/bun-sql-driver";
import { mysqlDialect } from "../../../src/db/driver/bun-sql/mysql-dialect";
import { DbQueryError } from "../../../src/db/errors";
import type { ConnectionConfig } from "../../../src/db/types";

function rows(objs: Array<Record<string, unknown>>, command = "SELECT"): BunSqlRows {
	const result = objs as BunSqlRows;
	result.count = objs.length;
	result.command = command;
	return result;
}

function fakeSql(): { sql: BunSqlLike; calls: string[] } {
	const calls: string[] = [];
	const run = async (sql: string): Promise<BunSqlRows> => {
		calls.push(sql);
		if (sql === "SELECT VERSION() AS v") {
			return rows([{ v: "8.0.36" }]);
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

const config: ConnectionConfig = { engine: "mysql", host: "h", database: "d", user: "u" };

function driver(sql: BunSqlLike): BunSqlDriver {
	return new BunSqlDriver(config, mysqlDialect, () => sql);
}

describe("BunSqlDriver (mysql)", () => {
	it("wraps a read query in a READ ONLY transaction", async () => {
		const { sql, calls } = fakeSql();
		const d = driver(sql);
		await d.connect();
		const result = await d.query({ sql: "SELECT 1 AS one", readOnly: true });
		expect(result.rows).toEqual([{ one: 1 }]);
		expect(calls).toContain("START TRANSACTION READ ONLY");
		expect(calls).toContain("COMMIT");
		await d.disconnect();
	});

	it("sets and then resets max_execution_time for a read with a deadline", async () => {
		const { sql, calls } = fakeSql();
		const d = driver(sql);
		await d.connect();
		await d.query({ sql: "SELECT 1 AS one", readOnly: true, timeoutMs: 1500 });
		expect(calls).toContain("SET max_execution_time = 1500");
		expect(calls).toContain("SET max_execution_time = 0");
		expect(calls.indexOf("SET max_execution_time = 1500")).toBeLessThan(calls.indexOf("SET max_execution_time = 0"));
		await d.disconnect();
	});

	it("omits max_execution_time when no deadline is given", async () => {
		const { sql, calls } = fakeSql();
		const d = driver(sql);
		await d.connect();
		await d.query({ sql: "SELECT 1 AS one", readOnly: true });
		expect(calls.some((c) => c.startsWith("SET max_execution_time"))).toBe(false);
		await d.disconnect();
	});

	it("testConnection reports the server version", async () => {
		const { sql } = fakeSql();
		const d = driver(sql);
		await d.connect();
		const res = await d.testConnection();
		expect(res.ok).toBe(true);
		expect(res.serverVersion).toBe("8.0.36");
		await d.disconnect();
	});

	it("issues ROLLBACK and throws DbQueryError when the read query fails", async () => {
		const calls: string[] = [];
		let released = false;
		const run = async (sql: string): Promise<BunSqlRows> => {
			calls.push(sql);
			if (sql.startsWith("START TRANSACTION") || sql === "ROLLBACK") {
				return [] as BunSqlRows;
			}
			throw new Error("query boom");
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
		await expect(d.query({ sql: "SELECT boom", readOnly: true })).rejects.toBeInstanceOf(DbQueryError);
		expect(calls).toContain("ROLLBACK");
		expect(released).toBe(true);
		await d.disconnect();
	});
});
