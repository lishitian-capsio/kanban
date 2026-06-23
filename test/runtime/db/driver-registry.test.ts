import { describe, expect, it } from "vitest";

import { createDriver, registerDriver } from "../../../src/db/driver/driver-registry";
import type { DatabaseDriver } from "../../../src/db/driver/driver";
import { UnsupportedEngineError } from "../../../src/db/errors";
import type { ConnectionConfig } from "../../../src/db/types";

function fakeDriver(config: ConnectionConfig): DatabaseDriver {
	return {
		engine: config.engine,
		connect: async () => {},
		disconnect: async () => {},
		testConnection: async () => ({ ok: true, latencyMs: 0, serverVersion: null }),
		query: async () => ({ rows: [], fields: [], rowCount: 0, durationMs: 0 }),
		introspect: async () => ({ engine: config.engine, tables: [] }),
	};
}

describe("driver-registry", () => {
	it("creates a registered driver", () => {
		registerDriver("postgres", fakeDriver);
		const driver = createDriver({ engine: "postgres", host: "h" });
		expect(driver.engine).toBe("postgres");
	});

	it("throws UnsupportedEngineError for an unregistered engine", () => {
		expect(() => createDriver({ engine: "mysql" } as ConnectionConfig)).toThrow(UnsupportedEngineError);
	});
});
