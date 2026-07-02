import { describe, expect, it } from "vitest";
import type { DatabaseDriver } from "../../../src/db/driver/driver";
import { createDriver, registerDriver } from "../../../src/db/driver/driver-registry";
import { isKeyspaceBrowser } from "../../../src/db/driver/driver";
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

describe("isKeyspaceBrowser", () => {
	it("is false for an object without browseKeyspace", () => {
		expect(isKeyspaceBrowser({ engine: "sqlite" } as never)).toBe(false);
	});
	it("is true when browseKeyspace is a function", () => {
		expect(isKeyspaceBrowser({ engine: "redis", browseKeyspace: () => undefined } as never)).toBe(true);
	});
});
