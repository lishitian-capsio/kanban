import { describe, expect, it } from "vitest";

import type { DatabaseDriver } from "../../../src/db/driver/driver";
import { PoolManager } from "../../../src/db/pool/pool-manager";
import type { ConnectionConfig } from "../../../src/db/types";

function makeDriver(): DatabaseDriver & { connects: number; disconnects: number } {
	const state = { connects: 0, disconnects: 0 };
	const driver = {
		engine: "sqlite",
		connects: 0,
		disconnects: 0,
		connect: async () => {
			state.connects += 1;
			(driver as { connects: number }).connects = state.connects;
		},
		disconnect: async () => {
			state.disconnects += 1;
			(driver as { disconnects: number }).disconnects = state.disconnects;
		},
		testConnection: async () => ({ ok: true, latencyMs: 0, serverVersion: null }),
		query: async () => ({ rows: [], fields: [], rowCount: 0, durationMs: 0 }),
		transaction: async (fn) => fn({ query: async () => ({ rows: [], fields: [], rowCount: 0, durationMs: 0 }) }),
		introspect: async () => ({ engine: "sqlite", tables: [] }),
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
	} as DatabaseDriver & { connects: number; disconnects: number };
	return driver;
}

const config: ConnectionConfig = { engine: "sqlite", filePath: "/tmp/x.db" };

describe("PoolManager", () => {
	it("creates a driver once and reuses it", async () => {
		const driver = makeDriver();
		const mgr = new PoolManager({ createDriver: () => driver });
		const a = await mgr.getDriver("c1", config);
		const b = await mgr.getDriver("c1", config);
		expect(a).toBe(b);
		expect(driver.connects).toBe(1);
		expect(mgr.size()).toBe(1);
	});

	it("de-dupes concurrent first-use connect calls", async () => {
		const driver = makeDriver();
		const mgr = new PoolManager({ createDriver: () => driver });
		const [a, b] = await Promise.all([mgr.getDriver("c1", config), mgr.getDriver("c1", config)]);
		expect(a).toBe(b);
		expect(driver.connects).toBe(1);
	});

	it("invalidate disconnects and evicts", async () => {
		const driver = makeDriver();
		const mgr = new PoolManager({ createDriver: () => driver });
		await mgr.getDriver("c1", config);
		await mgr.invalidate("c1");
		expect(driver.disconnects).toBe(1);
		expect(mgr.size()).toBe(0);
	});

	it("reapIdle evicts drivers idle past the timeout using the injected clock", async () => {
		let nowMs = 1000;
		const driver = makeDriver();
		const mgr = new PoolManager({ createDriver: () => driver, idleTimeoutMs: 500, now: () => nowMs });
		await mgr.getDriver("c1", config);
		nowMs = 1200; // within timeout
		await mgr.reapIdle();
		expect(mgr.size()).toBe(1);
		nowMs = 1700; // past timeout
		await mgr.reapIdle();
		expect(mgr.size()).toBe(0);
		expect(driver.disconnects).toBe(1);
	});

	it("disposeAll disconnects every driver", async () => {
		const d1 = makeDriver();
		const d2 = makeDriver();
		const drivers = [d1, d2];
		let i = 0;
		const mgr = new PoolManager({ createDriver: () => drivers[i++] });
		await mgr.getDriver("c1", config);
		await mgr.getDriver("c2", config);
		await mgr.disposeAll();
		expect(d1.disconnects).toBe(1);
		expect(d2.disconnects).toBe(1);
		expect(mgr.size()).toBe(0);
	});
});
