import { describe, expect, it } from "vitest";

import type { RuntimeDbTable } from "@/runtime/types";
import { buildFullRowKey, buildRowKey } from "./db-utils";

function table(): RuntimeDbTable {
	return {
		schema: "public",
		name: "logs",
		kind: "table",
		columns: [
			{ name: "kind", dataType: "text", nullable: false, isPrimaryKey: false, defaultValue: null },
			{ name: "note", dataType: "text", nullable: true, isPrimaryKey: false, defaultValue: null },
		],
	};
}

describe("buildRowKey", () => {
	it("returns null for a table with no primary key", () => {
		expect(buildRowKey(table(), { kind: "login", note: "x" })).toBeNull();
	});
});

describe("buildFullRowKey", () => {
	it("builds a key from every column's current value", () => {
		expect(buildFullRowKey(table(), { kind: "login", note: "x" })).toEqual([
			{ column: "kind", value: "login" },
			{ column: "note", value: "x" },
		]);
	});

	it("preserves NULL cells as null (so the backend renders IS NULL)", () => {
		expect(buildFullRowKey(table(), { kind: "login", note: null })).toEqual([
			{ column: "kind", value: "login" },
			{ column: "note", value: null },
		]);
	});

	it("treats a missing cell as null", () => {
		expect(buildFullRowKey(table(), { kind: "login" })).toEqual([
			{ column: "kind", value: "login" },
			{ column: "note", value: null },
		]);
	});
});
