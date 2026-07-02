import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { SqliteDriver } from "../../../src/db/driver/sqlite-driver";
import { createTempDir } from "../../utilities/temp-dir";

/**
 * The transactional write primitive (`driver.transaction`) backs the no-primary-key safe-edit path:
 * a write runs inside BEGIN/COMMIT and is rolled back if the caller's guard rejects it (e.g. it
 * matched more than one row). Real bun:sqlite round-trip — the guard's whole value is that the
 * over-affected rows are actually restored, which only a real engine proves.
 */
async function seededDbPath(): Promise<string> {
	const { path: dir } = createTempDir();
	const path = join(dir, "tx.db");
	const seed = new Database(path);
	// No primary key, and two byte-identical rows — the ambiguous case the guard must protect.
	seed.exec("CREATE TABLE logs (kind TEXT, note TEXT)");
	seed.exec("INSERT INTO logs (kind, note) VALUES ('login', 'x'), ('login', 'x'), ('logout', 'y')");
	seed.close();
	return path;
}

function countLogs(path: string, kind: string, note: string): number {
	const db = new Database(path, { readonly: true });
	const row = db.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind = ? AND note = ?").get(kind, note) as { n: number };
	db.close();
	return row.n;
}

describe("SqliteDriver.transaction", () => {
	it("commits the write when the callback resolves", async () => {
		const filePath = await seededDbPath();
		const driver = new SqliteDriver({ engine: "sqlite", filePath, allowWrites: true } as never);
		await driver.connect();
		const affected = await driver.transaction(async (tx) => {
			const res = await tx.query({
				sql: "UPDATE logs SET note = ? WHERE kind = ? AND note = ?",
				params: ["y2", "logout", "y"],
				readOnly: false,
			});
			return res.rowCount;
		});
		await driver.disconnect();
		expect(affected).toBe(1);
		expect(countLogs(filePath, "logout", "y2")).toBe(1);
	});

	it("rolls back the write when the callback throws", async () => {
		const filePath = await seededDbPath();
		const driver = new SqliteDriver({ engine: "sqlite", filePath, allowWrites: true } as never);
		await driver.connect();
		await expect(
			driver.transaction(async (tx) => {
				await tx.query({ sql: "DELETE FROM logs WHERE kind = ?", params: ["logout"], readOnly: false });
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await driver.disconnect();
		// The DELETE inside the rolled-back transaction must have no effect.
		expect(countLogs(filePath, "logout", "y")).toBe(1);
	});

	it("rolls back a full-row edit that matches more than one row (no-PK guard)", async () => {
		const filePath = await seededDbPath();
		const driver = new SqliteDriver({ engine: "sqlite", filePath, allowWrites: true } as never);
		await driver.connect();
		await expect(
			driver.transaction(async (tx) => {
				const res = await tx.query({
					sql: "UPDATE logs SET note = ? WHERE kind = ? AND note = ?",
					params: ["hacked", "login", "x"],
					readOnly: false,
				});
				if (res.rowCount > 1) {
					throw new Error(`matched ${res.rowCount} rows`);
				}
				return res.rowCount;
			}),
		).rejects.toThrow("matched 2 rows");
		await driver.disconnect();
		// Both ambiguous rows are untouched — nothing was hacked.
		expect(countLogs(filePath, "login", "x")).toBe(2);
		expect(countLogs(filePath, "login", "hacked")).toBe(0);
	});

	it("commits a full-row edit that matches exactly one row", async () => {
		const filePath = await seededDbPath();
		const driver = new SqliteDriver({ engine: "sqlite", filePath, allowWrites: true } as never);
		await driver.connect();
		const affected = await driver.transaction(async (tx) => {
			const res = await tx.query({
				sql: "UPDATE logs SET note = ? WHERE kind = ? AND note = ?",
				params: ["done", "logout", "y"],
				readOnly: false,
			});
			if (res.rowCount > 1) {
				throw new Error(`matched ${res.rowCount} rows`);
			}
			return res.rowCount;
		});
		await driver.disconnect();
		expect(affected).toBe(1);
		expect(countLogs(filePath, "logout", "done")).toBe(1);
	});
});
