import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";

import { SqliteDriver } from "../../../src/db/driver/sqlite-driver";
import { createTempDir } from "../../utilities/temp-dir";

/**
 * The SQLite driver runs on `bun:sqlite`, which is unavailable under plain Node,
 * so these tests use Bun's native test runner (`bun test test/bun`) and are
 * excluded from the Node `vitest` collection. See vitest.config.ts.
 *
 * Seed a database exercising every introspection facet: an INTEGER PRIMARY KEY
 * (rowid alias, no backing index), a composite primary key, a unique index, a
 * foreign key, and a view.
 */
async function seededDbPath(): Promise<string> {
	const { path: dir } = createTempDir();
	const path = join(dir, "introspect.db");
	const seed = new Database(path);
	seed.exec(`
		CREATE TABLE authors (
			id INTEGER PRIMARY KEY,
			email TEXT NOT NULL,
			name TEXT
		);
		CREATE UNIQUE INDEX authors_email_idx ON authors (email);
		CREATE TABLE books (
			author_id INTEGER NOT NULL,
			isbn TEXT NOT NULL,
			title TEXT,
			PRIMARY KEY (author_id, isbn),
			FOREIGN KEY (author_id) REFERENCES authors (id)
		);
		CREATE VIEW author_book_counts AS
			SELECT author_id, COUNT(*) AS n FROM books GROUP BY author_id;
	`);
	seed.close();
	return path;
}

async function openDriver(filePath: string): Promise<SqliteDriver> {
	const driver = new SqliteDriver({ engine: "sqlite", filePath } as never);
	await driver.connect();
	return driver;
}

describe("SqliteDriver lazy introspection", () => {
	it("lists schemas (the attached databases, normally just main)", async () => {
		const driver = await openDriver(await seededDbPath());
		const schemas = await driver.listSchemas();
		expect(schemas.map((s) => s.name)).toContain("main");
		await driver.disconnect();
	});

	it("lists tables and views, classifying kind, excluding sqlite_ internals", async () => {
		const driver = await openDriver(await seededDbPath());
		const tables = await driver.listTables("main");
		const byName = new Map(tables.map((t) => [t.name, t]));
		expect(byName.get("authors")?.kind).toBe("table");
		expect(byName.get("books")?.kind).toBe("table");
		expect(byName.get("author_book_counts")?.kind).toBe("view");
		expect([...byName.keys()].some((n) => n.startsWith("sqlite_"))).toBe(false);
		await driver.disconnect();
	});

	it("describes columns with a reliable INTEGER PRIMARY KEY flag (rowid alias)", async () => {
		const driver = await openDriver(await seededDbPath());
		const detail = await driver.describeTable("main", "authors");
		const id = detail.columns.find((c) => c.name === "id");
		const email = detail.columns.find((c) => c.name === "email");
		const name = detail.columns.find((c) => c.name === "name");
		expect(id?.isPrimaryKey).toBe(true);
		expect(email?.nullable).toBe(false);
		expect(name?.nullable).toBe(true);
		await driver.disconnect();
	});

	it("reports a composite primary key on every participating column", async () => {
		const driver = await openDriver(await seededDbPath());
		const detail = await driver.describeTable("main", "books");
		const pkColumns = detail.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
		expect(pkColumns.sort()).toEqual(["author_id", "isbn"]);
		await driver.disconnect();
	});

	it("reports a unique secondary index with its columns", async () => {
		const driver = await openDriver(await seededDbPath());
		const detail = await driver.describeTable("main", "authors");
		const idx = detail.indexes.find((i) => i.name === "authors_email_idx");
		expect(idx?.isUnique).toBe(true);
		expect(idx?.isPrimary).toBe(false);
		expect(idx?.columns).toEqual(["email"]);
		await driver.disconnect();
	});

	it("reports the foreign key from books to authors", async () => {
		const driver = await openDriver(await seededDbPath());
		const detail = await driver.describeTable("main", "books");
		expect(detail.foreignKeys).toHaveLength(1);
		const fk = detail.foreignKeys[0];
		expect(fk.columns).toEqual(["author_id"]);
		expect(fk.referencedTable).toBe("authors");
		expect(fk.referencedColumns).toEqual(["id"]);
		expect(fk.referencedSchema).toBe("main");
		await driver.disconnect();
	});

	it("metadataSignature changes after the file is mutated", async () => {
		const path = await seededDbPath();
		const driver = await openDriver(path);
		const before = await driver.metadataSignature();
		// Mutate out of band, then bump mtime so a same-size change is still observable.
		const writer = new Database(path);
		writer.exec("CREATE TABLE extra (id INTEGER PRIMARY KEY)");
		writer.close();
		const future = new Date(Date.now() + 2000);
		utimesSync(path, future, future);
		const after = await driver.metadataSignature();
		expect(after).not.toBe(before);
		await driver.disconnect();
	});
});
