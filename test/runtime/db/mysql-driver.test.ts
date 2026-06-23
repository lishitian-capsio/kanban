import { describe, expect, it, vi } from "vitest";

import { MysqlDriver, type MysqlPoolLike } from "../../../src/db/driver/mysql-driver";
import { DbQueryError } from "../../../src/db/errors";
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

	it("issues ROLLBACK and throws DbQueryError when the read query fails", async () => {
		const calls: string[] = [];
		const releaseSpy = vi.fn();
		const conn = {
			query: async (sql: string) => {
				calls.push(sql);
				if (sql.startsWith("START TRANSACTION") || sql === "ROLLBACK") {
					return [{ affectedRows: 0 }, undefined];
				}
				throw new Error("query boom");
			},
			release: releaseSpy,
		};
		const pool: MysqlPoolLike = {
			getConnection: async () => conn,
			query: async (_sql: string) => [[{ v: "8.0.36" }], [{ name: "v" }]],
			end: async () => {},
		};
		const driver = new MysqlDriver(config, () => pool);
		await driver.connect();
		await expect(driver.query({ sql: "SELECT boom", readOnly: true })).rejects.toBeInstanceOf(DbQueryError);
		expect(calls).toContain("ROLLBACK");
		expect(releaseSpy).toHaveBeenCalled();
		await driver.disconnect();
	});
});
