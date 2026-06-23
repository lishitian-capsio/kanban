import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SqliteDriver } from "../../../src/db/driver/sqlite-driver";
import { DbPolicyError } from "../../../src/db/errors";
import { createTempDir } from "../../utilities/temp-dir";

async function seededDbPath(): Promise<string> {
	const { path: dir } = createTempDir();
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

	it("introspects a table whose name requires SQLite identifier quoting", async () => {
		const { path: dir } = createTempDir();
		const path = join(dir, "quoted.db");
		const seed = new Database(path);
		seed.exec(`CREATE TABLE "weird name" (id INTEGER PRIMARY KEY)`);
		seed.close();
		const driver = new SqliteDriver({ engine: "sqlite", filePath: path } as never);
		await driver.connect();
		const schema = await driver.introspect();
		const table = schema.tables.find((t) => t.name === "weird name");
		expect(table).toBeDefined();
		expect(table?.columns.find((c) => c.name === "id")?.isPrimaryKey).toBe(true);
		await driver.disconnect();
	});
});
