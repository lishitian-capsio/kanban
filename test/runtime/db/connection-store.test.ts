import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	type ConnectionRecord,
	normalizeConnId,
	readConnections,
	readCredentials,
	resolveConnectionConfig,
	writeConnections,
	writeCredentials,
} from "../../../src/db/registry/connection-store";
import { createTempDir } from "../../utilities/temp-dir";

function record(connId: string, overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
	return {
		connId,
		label: `db ${connId}`,
		engine: "postgres",
		host: "localhost",
		port: 5432,
		database: "app",
		user: "postgres",
		filePath: null,
		ssl: null,
		allowWrites: false,
		createdAt: "2026-06-22T00:00:00.000Z",
		...overrides,
	};
}

describe("connection-store", () => {
	it("round-trips connection shards", async () => {
		const { path: dir } = createTempDir();
		const shardDir = join(dir, "db-connections");
		await writeConnections(shardDir, [record("a"), record("b", { allowWrites: true })]);

		const loaded = await readConnections(shardDir);
		expect(loaded.map((r) => r.connId).sort()).toEqual(["a", "b"]);
		expect(loaded.find((r) => r.connId === "b")?.allowWrites).toBe(true);

		const files = (await readdir(shardDir)).sort();
		expect(files).toEqual(["a.json", "b.json"]);
	});

	it("deletes shards absent from the next write", async () => {
		const { path: dir } = createTempDir();
		const shardDir = join(dir, "db-connections");
		await writeConnections(shardDir, [record("a"), record("b")]);
		await writeConnections(shardDir, [record("a")]);
		const files = await readdir(shardDir);
		expect(files).toEqual(["a.json"]);
	});

	it("round-trips credentials in a single machine-home file", async () => {
		const { path: dir } = createTempDir();
		const path = join(dir, "db-credentials.json");
		await writeCredentials(path, { credentials: { a: { password: "secret" } } });
		const loaded = await readCredentials(path);
		expect(loaded.credentials.a?.password).toBe("secret");
	});

	it("returns empty credentials when the file is missing", async () => {
		const { path: dir } = createTempDir();
		const loaded = await readCredentials(join(dir, "missing.json"));
		expect(loaded).toEqual({ credentials: {} });
	});

	it("merges record + credential into a ConnectionConfig (secret only in memory)", () => {
		const config = resolveConnectionConfig(record("a"), { password: "secret" });
		expect(config.engine).toBe("postgres");
		expect(config.host).toBe("localhost");
		expect(config.password).toBe("secret");
	});

	it("merges with no credential (password undefined)", () => {
		const config = resolveConnectionConfig(record("a"), undefined);
		expect(config.password).toBeUndefined();
	});

	it("normalizes mixed-case connId: shard file is lowercased and stored connId is normalized", async () => {
		const { path: dir } = createTempDir();
		const shardDir = join(dir, "db-connections");
		await writeConnections(shardDir, [record("Prod-DB")]);

		const files = (await readdir(shardDir)).sort();
		expect(files).toEqual(["prod-db.json"]);

		const loaded = await readConnections(shardDir);
		expect(loaded[0]?.connId).toBe("prod-db");
		expect(normalizeConnId("Prod-DB")).toBe("prod-db");
	});
});
