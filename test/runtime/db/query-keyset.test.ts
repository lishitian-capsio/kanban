import { describe, expect, it } from "vitest";

import { InvalidCursorError } from "../../../src/db/errors";
import {
	buildKeysetQuery,
	decodeBrowseCursor,
	decodeKeysetCursor,
	encodeBrowseCursor,
	encodeKeysetCursor,
	keyValuesOf,
	quoteIdentifier,
	quoteQualifiedTable,
	selectKeysetKey,
} from "../../../src/db/execution/query-keyset";
import type { TableDetail } from "../../../src/db/types";

function detail(columns: Array<{ name: string; isPrimaryKey?: boolean }>): TableDetail {
	return {
		schema: "main",
		name: "t",
		kind: "table",
		columns: columns.map((c) => ({
			name: c.name,
			dataType: "int",
			nullable: false,
			isPrimaryKey: c.isPrimaryKey ?? false,
			defaultValue: null,
		})),
		indexes: [],
		foreignKeys: [],
	};
}

describe("query-keyset", () => {
	it("quotes identifiers per engine and escapes the quote char", () => {
		expect(quoteIdentifier("postgres", "users")).toBe('"users"');
		expect(quoteIdentifier("sqlite", 'we"ird')).toBe('"we""ird"');
		expect(quoteIdentifier("mysql", "users")).toBe("`users`");
		expect(quoteIdentifier("mysql", "ba`ck")).toBe("`ba``ck`");
		expect(quoteQualifiedTable("postgres", "cat_0", "t_1")).toBe('"cat_0"."t_1"');
		expect(quoteQualifiedTable("mysql", "db", "t")).toBe("`db`.`t`");
	});

	it("selects the primary key as the ordering key, or null when there is none", () => {
		expect(selectKeysetKey(detail([{ name: "id", isPrimaryKey: true }, { name: "a" }]))).toEqual({ columns: ["id"] });
		expect(
			selectKeysetKey(detail([{ name: "a", isPrimaryKey: true }, { name: "b", isPrimaryKey: true }, { name: "c" }])),
		).toEqual({ columns: ["a", "b"] });
		expect(selectKeysetKey(detail([{ name: "a" }, { name: "b" }]))).toBeNull();
	});

	it("builds a first-page keyset query with no WHERE and a probe LIMIT", () => {
		const q = buildKeysetQuery({
			engine: "postgres",
			schema: "public",
			table: "big",
			keyColumns: ["id"],
			cursorValues: null,
			pageSize: 100,
		});
		expect(q.sql).toBe('SELECT * FROM "public"."big" ORDER BY "id" ASC LIMIT 101');
		expect(q.params).toEqual([]);
		expect(q.fetchLimit).toBe(101);
	});

	it("builds a single-key resume query with a scalar comparison and bound param", () => {
		const q = buildKeysetQuery({
			engine: "postgres",
			schema: "public",
			table: "big",
			keyColumns: ["id"],
			cursorValues: [500_000],
			pageSize: 100,
		});
		expect(q.sql).toBe('SELECT * FROM "public"."big" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 101');
		expect(q.params).toEqual([500_000]);
	});

	it("builds a composite-key resume query with a row-value comparison", () => {
		const pg = buildKeysetQuery({
			engine: "postgres",
			schema: "s",
			table: "t",
			keyColumns: ["a", "b"],
			cursorValues: [1, "x"],
			pageSize: 50,
		});
		expect(pg.sql).toBe('SELECT * FROM "s"."t" WHERE ("a", "b") > ($1, $2) ORDER BY "a" ASC, "b" ASC LIMIT 51');
		const my = buildKeysetQuery({
			engine: "mysql",
			schema: "s",
			table: "t",
			keyColumns: ["a", "b"],
			cursorValues: [1, "x"],
			pageSize: 50,
		});
		expect(my.sql).toBe("SELECT * FROM `s`.`t` WHERE (`a`, `b`) > (?, ?) ORDER BY `a` ASC, `b` ASC LIMIT 51");
		expect(my.params).toEqual([1, "x"]);
	});

	it("rejects a cursor whose arity does not match the key", () => {
		expect(() =>
			buildKeysetQuery({ engine: "sqlite", schema: "main", table: "t", keyColumns: ["a", "b"], cursorValues: [1], pageSize: 10 }),
		).toThrow(InvalidCursorError);
	});

	it("round-trips a keyset cursor including bigint and Date cell types", () => {
		const values = [42, "name", 9007199254740993n, new Date("2026-06-23T00:00:00.000Z")];
		const token = encodeKeysetCursor(values);
		const decoded = decodeKeysetCursor(token);
		expect(decoded?.[0]).toBe(42);
		expect(decoded?.[1]).toBe("name");
		expect(decoded?.[2]).toBe(9007199254740993n);
		expect(decoded?.[3]).toBeInstanceOf(Date);
		expect((decoded?.[3] as Date).toISOString()).toBe("2026-06-23T00:00:00.000Z");
	});

	it("round-trips an offset browse cursor and discriminates the mode", () => {
		const token = encodeBrowseCursor({ mode: "offset", offset: 250 });
		expect(decodeBrowseCursor(token)).toEqual({ mode: "offset", offset: 250 });
		// A keyset decode of an offset cursor is a mismatch.
		expect(() => decodeKeysetCursor(token)).toThrow(InvalidCursorError);
	});

	it("treats an absent cursor as the first page and a malformed cursor as invalid", () => {
		expect(decodeBrowseCursor(null)).toBeNull();
		expect(decodeBrowseCursor("")).toBeNull();
		expect(() => decodeBrowseCursor("not-base64-json!!")).toThrow(InvalidCursorError);
	});

	it("extracts key values from a row in key-column order", () => {
		expect(keyValuesOf({ id: 7, a: 1, b: "z" }, ["a", "id"])).toEqual([1, 7]);
	});
});
