import { describe, expect, it } from "bun:test";

import { defaultBunSqlFactory } from "../../../src/db/driver/bun-sql/bun-sql";
import { toQueryResult } from "../../../src/db/driver/bun-sql/dialect";

/**
 * Real `Bun.SQL` integration for the result-shaping seam (`toQueryResult`) and the default
 * factory / `unsafe` parameter binding. Uses Bun.SQL's `sqlite` adapter (`:memory:`) so it needs
 * no live server; it runs under `bun test test/bun` (excluded from the Node vitest collection).
 *
 * The read-only transaction path (`reserve()` + `BEGIN … READ ONLY`) is Postgres/MySQL-only —
 * Bun.SQL's sqlite adapter does not support connection reservation — so it stays covered by the
 * fake-injected vitest suites (`postgres-driver.test.ts` / `mysql-driver.test.ts`).
 */
describe("Bun.SQL result shaping (real client, sqlite adapter)", () => {
	it("shapes a read into rows + fields derived from column keys", async () => {
		const sql = defaultBunSqlFactory({ adapter: "sqlite", filename: ":memory:" });
		await sql.unsafe("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
		await sql.unsafe("INSERT INTO users (id, name) VALUES (1, 'alice'), (2, 'bob')");

		const started = performance.now();
		const rows = await sql.unsafe("SELECT id, name FROM users ORDER BY id", []);
		const result = toQueryResult(rows, started);

		expect(result.rows).toEqual([
			{ id: 1, name: "alice" },
			{ id: 2, name: "bob" },
		]);
		expect(result.fields.map((f) => f.name)).toEqual(["id", "name"]);
		expect(result.rowCount).toBe(2);
		await sql.close();
	});

	it("binds positional parameters through unsafe()", async () => {
		const sql = defaultBunSqlFactory({ adapter: "sqlite", filename: ":memory:" });
		await sql.unsafe("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
		await sql.unsafe("INSERT INTO users (id, name) VALUES (1, 'alice'), (2, 'bob')");

		const rows = await sql.unsafe("SELECT name FROM users WHERE id = ?", [2]);
		expect(toQueryResult(rows, performance.now()).rows).toEqual([{ name: "bob" }]);
		await sql.close();
	});

	it("reports affected rows (not row objects) for a write", async () => {
		const sql = defaultBunSqlFactory({ adapter: "sqlite", filename: ":memory:" });
		await sql.unsafe("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

		const rows = await sql.unsafe("INSERT INTO users (id, name) VALUES (?, ?)", [1, "alice"]);
		const result = toQueryResult(rows, performance.now());
		expect(result.rows).toEqual([]);
		expect(result.rowCount).toBe(1);
		await sql.close();
	});

	it("yields no columns for a zero-row read (Bun exposes no field metadata)", async () => {
		const sql = defaultBunSqlFactory({ adapter: "sqlite", filename: ":memory:" });
		await sql.unsafe("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

		const rows = await sql.unsafe("SELECT id, name FROM users WHERE id = ?", [999]);
		const result = toQueryResult(rows, performance.now());
		expect(result.rows).toEqual([]);
		expect(result.fields).toEqual([]);
		expect(result.rowCount).toBe(0);
		await sql.close();
	});
});
