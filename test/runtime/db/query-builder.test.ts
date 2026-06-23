import { describe, expect, it } from "vitest";

import {
	buildBrowseQuery,
	buildDeleteRow,
	buildInsertRow,
	buildUpdateRow,
	quoteIdentifier,
	quoteQualifiedTable,
} from "../../../src/db/query-builder";

describe("quoteIdentifier", () => {
	it("double-quotes for postgres and sqlite, escaping embedded quotes", () => {
		expect(quoteIdentifier("postgres", "users")).toBe('"users"');
		expect(quoteIdentifier("sqlite", "users")).toBe('"users"');
		expect(quoteIdentifier("postgres", 'we"ird')).toBe('"we""ird"');
	});

	it("backtick-quotes for mysql, escaping embedded backticks", () => {
		expect(quoteIdentifier("mysql", "users")).toBe("`users`");
		expect(quoteIdentifier("mysql", "we`ird")).toBe("`we``ird`");
	});
});

describe("quoteQualifiedTable", () => {
	it("qualifies with schema when present", () => {
		expect(quoteQualifiedTable("postgres", "public", "users")).toBe('"public"."users"');
	});

	it("omits an empty schema (sqlite)", () => {
		expect(quoteQualifiedTable("sqlite", "", "users")).toBe('"users"');
	});
});

describe("buildBrowseQuery", () => {
	it("selects all rows with no filters or sort", () => {
		const built = buildBrowseQuery({ engine: "postgres", schema: "public", table: "users" });
		expect(built.sql).toBe('SELECT * FROM "public"."users"');
		expect(built.params).toEqual([]);
	});

	it("builds a WHERE clause with positional placeholders for postgres", () => {
		const built = buildBrowseQuery({
			engine: "postgres",
			schema: "public",
			table: "users",
			filters: [
				{ column: "age", op: "gte", value: "18" },
				{ column: "name", op: "contains", value: "ann" },
			],
		});
		expect(built.sql).toBe('SELECT * FROM "public"."users" WHERE "age" >= $1 AND "name" LIKE $2');
		expect(built.params).toEqual(["18", "%ann%"]);
	});

	it("uses ? placeholders for mysql and sqlite", () => {
		const built = buildBrowseQuery({
			engine: "sqlite",
			schema: "",
			table: "users",
			filters: [{ column: "id", op: "eq", value: "1" }],
		});
		expect(built.sql).toBe('SELECT * FROM "users" WHERE "id" = ?');
		expect(built.params).toEqual(["1"]);
	});

	it("renders null-check operators without consuming a placeholder", () => {
		const built = buildBrowseQuery({
			engine: "postgres",
			schema: "public",
			table: "users",
			filters: [
				{ column: "deleted_at", op: "is_null" },
				{ column: "email", op: "eq", value: "a@b.c" },
			],
		});
		expect(built.sql).toBe('SELECT * FROM "public"."users" WHERE "deleted_at" IS NULL AND "email" = $1');
		expect(built.params).toEqual(["a@b.c"]);
	});

	it("appends ORDER BY for each sort column", () => {
		const built = buildBrowseQuery({
			engine: "mysql",
			schema: "shop",
			table: "orders",
			sort: [
				{ column: "created_at", direction: "desc" },
				{ column: "id", direction: "asc" },
			],
		});
		expect(built.sql).toBe("SELECT * FROM `shop`.`orders` ORDER BY `created_at` DESC, `id` ASC");
		expect(built.params).toEqual([]);
	});
});

describe("buildUpdateRow", () => {
	it("builds SET and WHERE with params ordered assignments-then-where", () => {
		const built = buildUpdateRow({
			engine: "postgres",
			schema: "public",
			table: "users",
			assignments: [
				{ column: "name", value: "alice" },
				{ column: "email", value: null },
			],
			where: [{ column: "id", value: "7" }],
		});
		expect(built.sql).toBe('UPDATE "public"."users" SET "name" = $1, "email" = $2 WHERE "id" = $3');
		expect(built.params).toEqual(["alice", null, "7"]);
	});

	it("throws when there are no assignments", () => {
		expect(() =>
			buildUpdateRow({ engine: "sqlite", schema: "", table: "t", assignments: [], where: [{ column: "id", value: "1" }] }),
		).toThrow();
	});

	it("throws when the WHERE key is empty (refuses an unbounded update)", () => {
		expect(() =>
			buildUpdateRow({
				engine: "sqlite",
				schema: "",
				table: "t",
				assignments: [{ column: "x", value: "1" }],
				where: [],
			}),
		).toThrow();
	});
});

describe("buildInsertRow", () => {
	it("builds an INSERT with column list and placeholders", () => {
		const built = buildInsertRow({
			engine: "mysql",
			schema: "shop",
			table: "orders",
			values: [
				{ column: "sku", value: "abc" },
				{ column: "qty", value: "3" },
			],
		});
		expect(built.sql).toBe("INSERT INTO `shop`.`orders` (`sku`, `qty`) VALUES (?, ?)");
		expect(built.params).toEqual(["abc", "3"]);
	});

	it("throws when there are no values", () => {
		expect(() => buildInsertRow({ engine: "sqlite", schema: "", table: "t", values: [] })).toThrow();
	});
});

describe("buildDeleteRow", () => {
	it("builds a DELETE bounded by the WHERE key", () => {
		const built = buildDeleteRow({
			engine: "postgres",
			schema: "public",
			table: "users",
			where: [
				{ column: "tenant", value: "acme" },
				{ column: "id", value: "7" },
			],
		});
		expect(built.sql).toBe('DELETE FROM "public"."users" WHERE "tenant" = $1 AND "id" = $2');
		expect(built.params).toEqual(["acme", "7"]);
	});

	it("throws when the WHERE key is empty (refuses an unbounded delete)", () => {
		expect(() => buildDeleteRow({ engine: "sqlite", schema: "", table: "t", where: [] })).toThrow();
	});
});
