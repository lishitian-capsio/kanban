import { describe, expect, it } from "vitest";

import { buildDeleteRow, buildInsertRow, buildUpdateRow } from "../../../src/db/query-builder";
import { assertSingleTableWrite, SingleTableWriteError } from "../../../src/db/policy/single-table-write";

describe("assertSingleTableWrite", () => {
	it("accepts a generated postgres UPDATE against the intended table", () => {
		const built = buildUpdateRow({
			engine: "postgres",
			schema: "public",
			table: "users",
			assignments: [{ column: "name", value: "alice" }],
			where: [{ column: "id", value: "7" }],
		});
		expect(() =>
			assertSingleTableWrite(built.sql, "postgres", { schema: "public", table: "users" }),
		).not.toThrow();
	});

	it("accepts a generated mysql INSERT against the intended table", () => {
		const built = buildInsertRow({
			engine: "mysql",
			schema: "shop",
			table: "orders",
			values: [{ column: "sku", value: "abc" }],
		});
		expect(() => assertSingleTableWrite(built.sql, "mysql", { schema: "shop", table: "orders" })).not.toThrow();
	});

	it("accepts a generated sqlite DELETE against the intended table", () => {
		const built = buildDeleteRow({ engine: "sqlite", schema: "", table: "users", where: [{ column: "id", value: "1" }] });
		expect(() => assertSingleTableWrite(built.sql, "sqlite", { schema: "", table: "users" })).not.toThrow();
	});

	it("rejects a write that targets a different table than intended", () => {
		const built = buildDeleteRow({ engine: "postgres", schema: "public", table: "users", where: [{ column: "id", value: "1" }] });
		expect(() => assertSingleTableWrite(built.sql, "postgres", { schema: "public", table: "accounts" })).toThrow(
			SingleTableWriteError,
		);
	});

	it("rejects a write that targets a different schema than intended", () => {
		const built = buildDeleteRow({ engine: "postgres", schema: "public", table: "users", where: [{ column: "id", value: "1" }] });
		expect(() => assertSingleTableWrite(built.sql, "postgres", { schema: "private", table: "users" })).toThrow(
			SingleTableWriteError,
		);
	});

	it("rejects a SELECT (not a single-row write)", () => {
		expect(() => assertSingleTableWrite('SELECT * FROM "users"', "postgres", { schema: "", table: "users" })).toThrow(
			SingleTableWriteError,
		);
	});

	it("rejects a DDL statement", () => {
		expect(() => assertSingleTableWrite('DROP TABLE "users"', "postgres", { schema: "", table: "users" })).toThrow(
			SingleTableWriteError,
		);
	});

	it("rejects an unparseable statement", () => {
		expect(() => assertSingleTableWrite("NOT SQL AT ALL", "postgres", { schema: "", table: "users" })).toThrow(
			SingleTableWriteError,
		);
	});
});
