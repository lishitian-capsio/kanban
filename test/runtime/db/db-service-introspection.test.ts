import { describe, expect, it } from "vitest";

import { DatabaseService } from "../../../src/db/db-service";
import type { DatabaseDriver } from "../../../src/db/driver/driver";
import { IntrospectionCache } from "../../../src/db/introspection/introspection-cache";
import { PoolManager } from "../../../src/db/pool/pool-manager";
import { type ConnectionRecord, normalizeConnId } from "../../../src/db/registry/connection-store";
import type { SchemaSummary, TableDetail, TableSummary } from "../../../src/db/types";

interface DriverCounts {
	listSchemas: number;
	listTables: number;
	describeTable: number;
}

function record(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
	return {
		connId: "c1",
		label: "c1",
		engine: "postgres",
		host: "h",
		port: 5432,
		database: "d",
		user: "u",
		filePath: null,
		ssl: null,
		allowWrites: false,
		createdAt: "2026-06-22T00:00:00.000Z",
		...overrides,
	};
}

/** A driver whose introspection methods count their calls and whose signature is mutable. */
function countingDriver(counts: DriverCounts, signature: { value: string }): DatabaseDriver {
	return {
		engine: "postgres",
		connect: async () => {},
		disconnect: async () => {},
		testConnection: async () => ({ ok: true, latencyMs: 1, serverVersion: "PostgreSQL 16" }),
		query: async () => ({ rows: [], fields: [], rowCount: 0, durationMs: 1 }),
		transaction: async (fn) => fn({ query: async () => ({ rows: [], fields: [], rowCount: 0, durationMs: 1 }) }),
		introspect: async () => ({ engine: "postgres", tables: [] }),
		listSchemas: async (): Promise<SchemaSummary[]> => {
			counts.listSchemas++;
			return [{ name: "public" }];
		},
		listTables: async (schema): Promise<TableSummary[]> => {
			counts.listTables++;
			return [{ schema, name: "users", kind: "table" }];
		},
		describeTable: async (schema, table): Promise<TableDetail> => {
			counts.describeTable++;
			return { schema, name: table, kind: "table", columns: [], indexes: [], foreignKeys: [] };
		},
		metadataSignature: async () => signature.value,
	};
}

function makeService(rec: ConnectionRecord) {
	const counts: DriverCounts = { listSchemas: 0, listTables: 0, describeTable: 0 };
	const signature = { value: "" };
	const poolManager = new PoolManager({ createDriver: () => countingDriver(counts, signature) });
	const introspectionCache = new IntrospectionCache();
	const svc = new DatabaseService({
		poolManager,
		loadConnection: async (id) => (normalizeConnId(id) === normalizeConnId(rec.connId) ? rec : null),
		loadCredential: async () => undefined,
		introspectionCache,
	});
	return { svc, counts, signature };
}

describe("DatabaseService lazy introspection", () => {
	it("delegates each level to the driver", async () => {
		const { svc } = makeService(record());
		expect((await svc.listSchemas({ connId: "c1", caller: "human" })).map((s) => s.name)).toEqual(["public"]);
		expect((await svc.listTables({ connId: "c1", caller: "human", schema: "public" }))[0].name).toBe("users");
		const detail = await svc.describeTable({ connId: "c1", caller: "human", schema: "public", table: "users" });
		expect(detail.name).toBe("users");
	});

	it("caches each level so repeated reads do not re-hit the driver", async () => {
		const { svc, counts } = makeService(record());
		await svc.listSchemas({ connId: "c1", caller: "human" });
		await svc.listSchemas({ connId: "c1", caller: "agent" });
		await svc.listTables({ connId: "c1", caller: "human", schema: "public" });
		await svc.listTables({ connId: "c1", caller: "human", schema: "public" });
		await svc.describeTable({ connId: "c1", caller: "human", schema: "public", table: "users" });
		await svc.describeTable({ connId: "c1", caller: "human", schema: "public", table: "users" });
		expect(counts).toEqual({ listSchemas: 1, listTables: 1, describeTable: 1 });
	});

	it("re-reads when the driver metadata signature changes (out-of-process change)", async () => {
		const { svc, counts, signature } = makeService(record());
		await svc.listSchemas({ connId: "c1", caller: "human" });
		signature.value = "changed";
		await svc.listSchemas({ connId: "c1", caller: "human" });
		expect(counts.listSchemas).toBe(2);
	});

	it("invalidates cached metadata after a write/DDL succeeds", async () => {
		const { svc, counts } = makeService(record({ allowWrites: true }));
		await svc.listSchemas({ connId: "c1", caller: "human" });
		expect(counts.listSchemas).toBe(1);
		// A write through the same connection may have changed the schema.
		await svc.runQuery({ connId: "c1", sql: "CREATE TABLE t (id int)", caller: "human" });
		await svc.listSchemas({ connId: "c1", caller: "human" });
		expect(counts.listSchemas).toBe(2);
	});

	it("does NOT invalidate cached metadata after a read-only query", async () => {
		const { svc, counts } = makeService(record());
		await svc.listSchemas({ connId: "c1", caller: "human" });
		await svc.runQuery({ connId: "c1", sql: "SELECT 1", caller: "human" });
		await svc.listSchemas({ connId: "c1", caller: "human" });
		expect(counts.listSchemas).toBe(1);
	});

	it("invalidate(connId) drops cached metadata", async () => {
		const { svc, counts } = makeService(record());
		await svc.listSchemas({ connId: "c1", caller: "human" });
		await svc.invalidate("c1");
		await svc.listSchemas({ connId: "c1", caller: "human" });
		expect(counts.listSchemas).toBe(2);
	});

	it("normalizes the connId so a write invalidates a differently-cased cached read", async () => {
		const { svc, counts } = makeService(record({ allowWrites: true }));
		await svc.listSchemas({ connId: "C1", caller: "human" });
		await svc.runQuery({ connId: "c1", sql: "CREATE TABLE t (id int)", caller: "human" });
		await svc.listSchemas({ connId: "C1", caller: "human" });
		expect(counts.listSchemas).toBe(2);
	});
});
