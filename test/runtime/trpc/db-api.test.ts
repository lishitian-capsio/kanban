import { describe, expect, it } from "vitest";
import type { DatabaseDriver } from "../../../src/db/driver/driver";
import { PoolManager } from "../../../src/db/pool/pool-manager";
import type { ConnectionRecord, DbCredential } from "../../../src/db/registry/connection-store";
import { normalizeConnId } from "../../../src/db/registry/connection-store";
import type { QueryRequest } from "../../../src/db/types";
import { createDbApi } from "../../../src/trpc/db-api";

const SCOPE = { workspaceId: "ws-1", workspacePath: "/tmp/repo" };

function fakeDriver(seen: QueryRequest[]): DatabaseDriver {
	return {
		engine: "postgres",
		connect: async () => {},
		disconnect: async () => {},
		testConnection: async () => ({ ok: true, latencyMs: 7, serverVersion: "PostgreSQL 16" }),
		query: async (request) => {
			seen.push(request);
			return {
				rows: [{ id: 1 }, { id: 2 }],
				fields: [{ name: "id" }],
				rowCount: 2,
				durationMs: 3,
			};
		},
		introspect: async () => {
			introspectCalls.introspect++;
			return {
				engine: "postgres" as const,
				tables: [
					{
						schema: "public",
						name: "users",
						kind: "table" as const,
						columns: [
							{ name: "id", dataType: "int4", nullable: false, isPrimaryKey: true, defaultValue: null },
							{ name: "email", dataType: "text", nullable: false, isPrimaryKey: false, defaultValue: null },
						],
					},
					{ schema: "audit", name: "events", kind: "view" as const, columns: [] },
				],
			};
		},
		// Lazy, hierarchical introspection — the path the entry now uses (counted in `introspectCalls`).
		listSchemas: async () => {
			introspectCalls.listSchemas++;
			return [{ name: "public" }, { name: "audit" }];
		},
		listTables: async (schema) => {
			introspectCalls.listTables++;
			if (schema === "public") {
				return [{ schema: "public", name: "users", kind: "table" as const }];
			}
			if (schema === "audit") {
				return [{ schema: "audit", name: "events", kind: "view" as const }];
			}
			return [];
		},
		describeTable: async (schema, table) => {
			introspectCalls.describeTable++;
			if (schema === "public" && table === "users") {
				return {
					schema: "public",
					name: "users",
					kind: "table",
					columns: [
						{ name: "id", dataType: "int4", nullable: false, isPrimaryKey: true, defaultValue: null },
						{ name: "email", dataType: "text", nullable: false, isPrimaryKey: false, defaultValue: null },
					],
					indexes: [],
					foreignKeys: [],
				};
			}
			return { schema, name: table, kind: "table", columns: [], indexes: [], foreignKeys: [] };
		},
		metadataSignature: async () => "const",
	};
}

/** Counts how often each lazy introspection method is hit (to assert caching / no eager scan). */
const introspectCalls = { introspect: 0, listSchemas: 0, listTables: 0, describeTable: 0 };

interface Harness {
	api: ReturnType<typeof createDbApi>;
	records: ConnectionRecord[];
	credentials: Map<string, DbCredential>;
	seen: QueryRequest[];
}

function makeHarness(initial: ConnectionRecord[] = []): Harness {
	const records = [...initial];
	const credentials = new Map<string, DbCredential>();
	const seen: QueryRequest[] = [];
	const poolManager = new PoolManager({ createDriver: () => fakeDriver(seen) });
	const api = createDbApi({
		poolManager,
		loadConnections: async () => records,
		mutateConnections: async (_workspaceId, mutate) => {
			const next = await mutate([...records]);
			records.splice(0, records.length, ...next);
			return records;
		},
		loadCredential: async (connId) => credentials.get(normalizeConnId(connId)),
		mutateCredential: async (connId, mutate) => {
			const id = normalizeConnId(connId);
			const next = mutate(credentials.get(id));
			if (next === undefined) {
				credentials.delete(id);
			} else {
				credentials.set(id, next);
			}
		},
		now: () => new Date("2026-06-23T00:00:00.000Z"),
	});
	return { api, records, credentials, seen };
}

function pgRecord(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
	return {
		connId: "main",
		label: "Main",
		engine: "postgres",
		host: "db",
		port: 5432,
		database: "app",
		user: "app",
		filePath: null,
		ssl: null,
		allowWrites: false,
		createdAt: "2026-06-22T00:00:00.000Z",
		...overrides,
	};
}

describe("createDbApi", () => {
	it("adds a connection, slugs the id from the label, and stores the secret out-of-band", async () => {
		const h = makeHarness();
		const result = await h.api.addConnection(SCOPE, {
			label: "Prod Reader",
			engine: "postgres",
			host: "db",
			port: 5432,
			password: "s3cret",
		});
		expect(result.connection.connId).toBe("prod-reader");
		expect(result.connection.hasCredential).toBe(true);
		expect(result.connection.allowWrites).toBe(false);
		// The record is committed secret-free; the password lives only in the credential store.
		expect(h.records[0]).not.toHaveProperty("password");
		expect(h.credentials.get("prod-reader")).toEqual({ password: "s3cret" });
	});

	it("rejects a duplicate connection id", async () => {
		const h = makeHarness([pgRecord({ connId: "main" })]);
		await expect(h.api.addConnection(SCOPE, { connId: "main", label: "Main", engine: "postgres" })).rejects.toThrow(
			/already exists/,
		);
	});

	it("lists connections with credential presence", async () => {
		const h = makeHarness([pgRecord({ connId: "main" })]);
		h.credentials.set("main", { password: "x" });
		const result = await h.api.listConnections(SCOPE);
		expect(result.connections).toHaveLength(1);
		expect(result.connections[0]).toMatchObject({ connId: "main", hasCredential: true });
	});

	it("removes a connection and clears its secret", async () => {
		const h = makeHarness([pgRecord({ connId: "main" })]);
		h.credentials.set("main", { password: "x" });
		const result = await h.api.removeConnection(SCOPE, { connId: "MAIN" });
		expect(result.removed).toBe(true);
		expect(h.records).toHaveLength(0);
		expect(h.credentials.has("main")).toBe(false);
	});

	it("reports test connectivity from the core", async () => {
		const h = makeHarness([pgRecord({ connId: "main" })]);
		const result = await h.api.testConnection(SCOPE, { connId: "main" });
		expect(result).toMatchObject({ connId: "main", reachable: true, latencyMs: 7, serverVersion: "PostgreSQL 16" });
	});

	it("throws NOT_FOUND for an unknown connection", async () => {
		const h = makeHarness();
		await expect(h.api.testConnection(SCOPE, { connId: "ghost" })).rejects.toThrow(/unknown connection/);
	});

	it("lists tables (names only, no eager column scan) and filters by schema", async () => {
		const h = makeHarness([pgRecord({ connId: "list-tables" })]);
		introspectCalls.introspect = 0;
		const all = await h.api.listTables(SCOPE, { connId: "list-tables" });
		expect(all.tables).toEqual([
			{ schema: "public", name: "users", kind: "table" },
			{ schema: "audit", name: "events", kind: "view" },
		]);
		// The entry must NOT use the eager whole-catalog introspect() anymore.
		expect(introspectCalls.introspect).toBe(0);
		const filtered = await h.api.listTables(SCOPE, { connId: "list-tables", schema: "PUBLIC" });
		expect(filtered.tables).toHaveLength(1);
		expect(filtered.tables[0].name).toBe("users");
	});

	it("describes ONE table via the lazy cached path (no eager whole-catalog scan)", async () => {
		const h = makeHarness([pgRecord({ connId: "describe-one" })]);
		introspectCalls.introspect = 0;
		const result = await h.api.describeTable(SCOPE, { connId: "describe-one", table: "Users" });
		expect(result.table?.name).toBe("users");
		expect(result.table?.columns.map((column) => column.name)).toEqual(["id", "email"]);
		expect(introspectCalls.introspect).toBe(0);
	});

	it("re-expanding an unchanged catalog hits the introspection cache (no new DB round-trips)", async () => {
		const h = makeHarness([pgRecord({ connId: "cache-warm" })]);
		// Warm the cache.
		await h.api.listTables(SCOPE, { connId: "cache-warm" });
		await h.api.describeTable(SCOPE, { connId: "cache-warm", table: "users" });
		const before = { ...introspectCalls };
		// Repeat the same expansions — must be served entirely from the cache.
		await h.api.listTables(SCOPE, { connId: "cache-warm" });
		await h.api.describeTable(SCOPE, { connId: "cache-warm", table: "users" });
		expect(introspectCalls.listSchemas).toBe(before.listSchemas);
		expect(introspectCalls.listTables).toBe(before.listTables);
		expect(introspectCalls.describeTable).toBe(before.describeTable);
	});

	it("returns a null table for an unknown table name", async () => {
		const h = makeHarness([pgRecord({ connId: "main" })]);
		const result = await h.api.describeTable(SCOPE, { connId: "main", table: "missing" });
		expect(result.table).toBeNull();
	});

	it("runs a read query bounded read-only with the cli caller", async () => {
		const h = makeHarness([pgRecord({ connId: "main" })]);
		const result = await h.api.runQuery(SCOPE, { connId: "main", sql: "SELECT * FROM users" });
		expect(result.readOnly).toBe(true);
		expect(result.classification).toBe("read");
		expect(result.rowCount).toBe(2);
		expect(result.affectedRows).toBeNull();
		// The executor wraps reads with a server-side LIMIT, so the driver sees a bounded statement.
		expect(h.seen[0].readOnly).toBe(true);
	});

	it("blocks a write on a read-only connection for the cli caller", async () => {
		const h = makeHarness([pgRecord({ connId: "main", allowWrites: false })]);
		await expect(h.api.runQuery(SCOPE, { connId: "main", sql: "DELETE FROM users" })).rejects.toThrow(/read-only/);
		expect(h.seen).toHaveLength(0);
	});

	it("blocks a write for the cli caller even on a write-enabled connection", async () => {
		// allowWrites is for the human Database UI; the CLI (agent channel) stays strictly read-only.
		const h = makeHarness([pgRecord({ connId: "main", allowWrites: true })]);
		await expect(h.api.runQuery(SCOPE, { connId: "main", sql: "DELETE FROM users" })).rejects.toThrow(/read-only/);
		expect(h.seen).toHaveLength(0);
	});
});
