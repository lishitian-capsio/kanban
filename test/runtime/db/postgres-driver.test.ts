import { describe, expect, it } from "vitest";

import { PostgresDriver, type PgPoolLike } from "../../../src/db/driver/postgres-driver";
import { DbQueryError } from "../../../src/db/errors";
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

	it("issues ROLLBACK and releases the client when a read-only query throws", async () => {
		const queriedTexts: string[] = [];
		let released = false;
		const client = {
			query: async (text: string) => {
				queriedTexts.push(text);
				if (text === "SELECT bad") {
					throw new Error("syntax error");
				}
				return { rows: [], fields: [], rowCount: 0 };
			},
			release: () => {
				released = true;
			},
		};
		const pool: PgPoolLike = {
			connect: async () => client,
			query: async () => ({ rows: [], fields: [], rowCount: 0 }),
			end: async () => {},
		};
		const driver = new PostgresDriver(config, () => pool);
		await driver.connect();
		await expect(driver.query({ sql: "SELECT bad", readOnly: true })).rejects.toBeInstanceOf(DbQueryError);
		expect(queriedTexts).toContain("ROLLBACK");
		expect(released).toBe(true);
		await driver.disconnect();
	});
});
