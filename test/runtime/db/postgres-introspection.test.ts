import { describe, expect, it } from "vitest";

import { type PgPoolLike, PostgresDriver } from "../../../src/db/driver/postgres-driver";
import type { ConnectionConfig } from "../../../src/db/types";

const config: ConnectionConfig = { engine: "postgres", host: "h", database: "d", user: "u" };

interface FakeRows {
	[marker: string]: Array<Record<string, unknown>>;
}

/**
 * A pool that routes each catalog query to canned rows by a distinctive
 * substring, so the test exercises the driver's row-folding logic without a
 * real Postgres (mirrors the existing postgres-driver.test fake style).
 */
function fakePool(rows: FakeRows): PgPoolLike {
	const answer = (text: string): Array<Record<string, unknown>> => {
		for (const [marker, value] of Object.entries(rows)) {
			if (text.includes(marker)) {
				return value;
			}
		}
		return [];
	};
	return {
		connect: async () => ({ query: async () => ({ rows: [], fields: [], rowCount: 0 }), release: () => {} }),
		query: async (text: string) => {
			const result = answer(text);
			return { rows: result, fields: [], rowCount: result.length };
		},
		end: async () => {},
	};
}

async function driverWith(rows: FakeRows): Promise<PostgresDriver> {
	const driver = new PostgresDriver(config, () => fakePool(rows));
	await driver.connect();
	return driver;
}

describe("PostgresDriver lazy introspection", () => {
	it("lists user schemas", async () => {
		const driver = await driverWith({
			"information_schema.schemata": [{ schema_name: "public" }, { schema_name: "app" }],
		});
		const schemas = await driver.listSchemas();
		expect(schemas.map((s) => s.name)).toEqual(["public", "app"]);
		await driver.disconnect();
	});

	it("lists tables and views, classifying kind", async () => {
		const driver = await driverWith({
			"FROM information_schema.tables": [
				{ table_name: "users", table_type: "BASE TABLE" },
				{ table_name: "active_users", table_type: "VIEW" },
			],
		});
		const tables = await driver.listTables("public");
		expect(tables).toEqual([
			{ schema: "public", name: "users", kind: "table" },
			{ schema: "public", name: "active_users", kind: "view" },
		]);
		await driver.disconnect();
	});

	it("describes columns, indexes (ordered), and foreign keys", async () => {
		const driver = await driverWith({
			"FROM information_schema.columns": [
				{ column_name: "id", data_type: "integer", is_nullable: "NO", column_default: null, is_primary_key: true },
				{ column_name: "email", data_type: "text", is_nullable: "NO", column_default: null, is_primary_key: false },
				{
					column_name: "org_id",
					data_type: "integer",
					is_nullable: "YES",
					column_default: null,
					is_primary_key: false,
				},
			],
			pg_index: [
				{ index_name: "users_pkey", is_unique: true, is_primary: true, column_name: "id", ord: 1 },
				{ index_name: "users_org_email_idx", is_unique: true, is_primary: false, column_name: "org_id", ord: 1 },
				{ index_name: "users_org_email_idx", is_unique: true, is_primary: false, column_name: "email", ord: 2 },
			],
			pg_constraint: [
				{
					fk_name: "users_org_fk",
					column_name: "org_id",
					ref_schema: "public",
					ref_table: "orgs",
					ref_column: "id",
					ord: 1,
				},
			],
		});
		const detail = await driver.describeTable("public", "users");

		expect(detail.columns.find((c) => c.name === "id")?.isPrimaryKey).toBe(true);
		expect(detail.columns.find((c) => c.name === "org_id")?.nullable).toBe(true);

		const composite = detail.indexes.find((i) => i.name === "users_org_email_idx");
		expect(composite?.columns).toEqual(["org_id", "email"]); // ordered by ord
		expect(composite?.isUnique).toBe(true);
		expect(detail.indexes.find((i) => i.name === "users_pkey")?.isPrimary).toBe(true);

		expect(detail.foreignKeys).toEqual([
			{
				name: "users_org_fk",
				columns: ["org_id"],
				referencedSchema: "public",
				referencedTable: "orgs",
				referencedColumns: ["id"],
			},
		]);
		await driver.disconnect();
	});

	it("metadataSignature is a constant (remote engine — mutation-gated caching)", async () => {
		const driver = await driverWith({});
		expect(await driver.metadataSignature()).toBe("");
		await driver.disconnect();
	});
});
