import { describe, expect, it } from "vitest";

import { DatabaseService } from "../../../src/db/db-service";
import type { DatabaseDriver } from "../../../src/db/driver/driver";
import { DbConnectionError, DbPolicyError } from "../../../src/db/errors";
import { PoolManager } from "../../../src/db/pool/pool-manager";
import type { ConnectionRecord } from "../../../src/db/registry/connection-store";
import type { QueryRequest } from "../../../src/db/types";

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

function fakeDriver(seen: QueryRequest[]): DatabaseDriver {
	return {
		engine: "postgres",
		connect: async () => {},
		disconnect: async () => {},
		testConnection: async () => ({ ok: true, latencyMs: 1, serverVersion: "PostgreSQL 16" }),
		query: async (req) => {
			seen.push(req);
			return { rows: [{ ok: 1 }], fields: [{ name: "ok" }], rowCount: 1, durationMs: 1 };
		},
		introspect: async () => ({ engine: "postgres", tables: [] }),
		listSchemas: async () => [],
		listTables: async () => [],
		describeTable: async (schema, table) => ({
			schema,
			name: table,
			kind: "table",
			columns: [],
			indexes: [],
			foreignKeys: [],
		}),
		metadataSignature: async () => "",
	};
}

function makeService(rec: ConnectionRecord, seen: QueryRequest[]) {
	const poolManager = new PoolManager({ createDriver: () => fakeDriver(seen) });
	return new DatabaseService({
		poolManager,
		loadConnection: async (id) => (id === rec.connId ? rec : null),
		loadCredential: async () => ({ password: "secret" }),
	});
}

describe("DatabaseService", () => {
	it("runs a read query and passes readOnly=true to the driver", async () => {
		const seen: QueryRequest[] = [];
		const svc = makeService(record(), seen);
		const result = await svc.runQuery({ connId: "c1", sql: "SELECT 1 AS ok", caller: "human" });
		expect(result.rowCount).toBe(1);
		expect(seen[0].readOnly).toBe(true);
	});

	it("blocks a write from the agent caller even when the connection allows writes", async () => {
		const seen: QueryRequest[] = [];
		const svc = makeService(record({ allowWrites: true }), seen);
		await expect(svc.runQuery({ connId: "c1", sql: "DELETE FROM t", caller: "agent" })).rejects.toBeInstanceOf(
			DbPolicyError,
		);
		expect(seen).toHaveLength(0); // never reached the driver
	});

	it("allows a write for human when the connection opts in", async () => {
		const seen: QueryRequest[] = [];
		const svc = makeService(record({ allowWrites: true }), seen);
		await svc.runQuery({ connId: "c1", sql: "DELETE FROM t", caller: "human" });
		expect(seen[0].readOnly).toBe(false);
	});

	it("throws for an unknown connection id", async () => {
		const seen: QueryRequest[] = [];
		const svc = makeService(record(), seen);
		await expect(svc.runQuery({ connId: "missing", sql: "SELECT 1", caller: "cli" })).rejects.toBeInstanceOf(
			DbConnectionError,
		);
	});
});
