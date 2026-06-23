import { describe, expect, it } from "vitest";

import { MysqlDriver, type MysqlPoolLike } from "../../../src/db/driver/mysql-driver";
import type { ConnectionConfig } from "../../../src/db/types";

const config: ConnectionConfig = { engine: "mysql", host: "h", database: "d", user: "u" };

interface FakeRows {
	[marker: string]: Array<Record<string, unknown>>;
}

/** Route each catalog query to canned rows by a distinctive substring. */
function fakePool(rows: FakeRows): MysqlPoolLike {
	const answer = (sql: string): Array<Record<string, unknown>> => {
		for (const [marker, value] of Object.entries(rows)) {
			if (sql.includes(marker)) {
				return value;
			}
		}
		return [];
	};
	const query = async (sql: string): Promise<[unknown, undefined]> => [answer(sql), undefined];
	return {
		getConnection: async () => ({ query, release: () => {} }),
		query,
		end: async () => {},
	};
}

async function driverWith(rows: FakeRows): Promise<MysqlDriver> {
	const driver = new MysqlDriver(config, () => fakePool(rows));
	await driver.connect();
	return driver;
}

describe("MysqlDriver lazy introspection", () => {
	it("lists user databases as schemas", async () => {
		const driver = await driverWith({
			"information_schema.SCHEMATA": [{ schema_name: "shop" }, { schema_name: "analytics" }],
		});
		const schemas = await driver.listSchemas();
		expect(schemas.map((s) => s.name)).toEqual(["shop", "analytics"]);
		await driver.disconnect();
	});

	it("lists tables and views, classifying kind", async () => {
		const driver = await driverWith({
			"FROM information_schema.TABLES": [
				{ table_name: "orders", table_type: "BASE TABLE" },
				{ table_name: "order_totals", table_type: "VIEW" },
			],
		});
		const tables = await driver.listTables("shop");
		expect(tables).toEqual([
			{ schema: "shop", name: "orders", kind: "table" },
			{ schema: "shop", name: "order_totals", kind: "view" },
		]);
		await driver.disconnect();
	});

	it("describes columns, indexes (ordered), and foreign keys", async () => {
		const driver = await driverWith({
			"FROM information_schema.COLUMNS": [
				{ column_name: "id", data_type: "int", is_nullable: "NO", column_default: null, is_primary_key: 1 },
				{ column_name: "sku", data_type: "varchar", is_nullable: "NO", column_default: null, is_primary_key: 0 },
				{
					column_name: "supplier_id",
					data_type: "int",
					is_nullable: "YES",
					column_default: null,
					is_primary_key: 0,
				},
			],
			"information_schema.STATISTICS": [
				{ index_name: "PRIMARY", non_unique: 0, seq_in_index: 1, column_name: "id" },
				{ index_name: "idx_sku_supplier", non_unique: 0, seq_in_index: 1, column_name: "sku" },
				{ index_name: "idx_sku_supplier", non_unique: 0, seq_in_index: 2, column_name: "supplier_id" },
			],
			KEY_COLUMN_USAGE: [
				{
					constraint_name: "fk_supplier",
					column_name: "supplier_id",
					ref_schema: "shop",
					ref_table: "suppliers",
					ref_column: "id",
					ordinal_position: 1,
				},
			],
		});
		const detail = await driver.describeTable("shop", "products");

		expect(detail.columns.find((c) => c.name === "id")?.isPrimaryKey).toBe(true);
		expect(detail.columns.find((c) => c.name === "supplier_id")?.nullable).toBe(true);

		const primary = detail.indexes.find((i) => i.name === "PRIMARY");
		expect(primary?.isPrimary).toBe(true);
		expect(primary?.isUnique).toBe(true);
		const composite = detail.indexes.find((i) => i.name === "idx_sku_supplier");
		expect(composite?.columns).toEqual(["sku", "supplier_id"]); // ordered by seq_in_index
		expect(composite?.isPrimary).toBe(false);

		expect(detail.foreignKeys).toEqual([
			{
				name: "fk_supplier",
				columns: ["supplier_id"],
				referencedSchema: "shop",
				referencedTable: "suppliers",
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
