import { describe, expect, it } from "vitest";
import { DbPolicyError } from "../../../src/db/errors";
import { RedisDriver } from "../../../src/db/driver/redis/redis-driver";
import type { RedisClientLike } from "../../../src/db/driver/redis/redis-client";
import type { ConnectionConfig } from "../../../src/db/types";

/** A fake RedisClient driven by a per-command handler; records every send. */
function fakeClient(handler: (command: string, args: string[]) => unknown): {
	client: RedisClientLike;
	calls: Array<{ command: string; args: string[] }>;
} {
	const calls: Array<{ command: string; args: string[] }> = [];
	const client: RedisClientLike = {
		connected: true,
		connect: async () => {},
		close: () => {},
		send: async (command, args) => {
			calls.push({ command, args });
			return handler(command, args);
		},
	};
	return { client, calls };
}

const config: ConnectionConfig = { engine: "redis", host: "h", port: 6379, database: "0" };

function driver(client: RedisClientLike): RedisDriver {
	return new RedisDriver(config, () => client);
}

describe("RedisDriver", () => {
	it("testConnection returns the redis_version from INFO", async () => {
		const { client } = fakeClient((cmd) => {
			if (cmd === "PING") return "PONG";
			if (cmd === "INFO") return "# Server\r\nredis_version:7.2.4\r\n";
			return null;
		});
		const d = driver(client);
		await d.connect();
		const r = await d.testConnection();
		expect(r.ok).toBe(true);
		expect(r.serverVersion).toBe("7.2.4");
	});

	it("query runs an allowlisted command and shapes the reply", async () => {
		const { client, calls } = fakeClient((cmd) => (cmd === "HGETALL" ? { a: "1" } : null));
		const d = driver(client);
		await d.connect();
		const r = await d.query({ sql: "HGETALL user:1", readOnly: true });
		expect(r.rows).toEqual([{ field: "a", value: "1" }]);
		expect(calls.some((c) => c.command === "HGETALL")).toBe(true);
	});

	it("query refuses a non-allowlisted command", async () => {
		const { client } = fakeClient(() => null);
		const d = driver(client);
		await d.connect();
		await expect(d.query({ sql: "SET k v", readOnly: true })).rejects.toBeInstanceOf(DbPolicyError);
	});

	it("listTables groups keys by prefix (bounded SCAN sweep)", async () => {
		const { client } = fakeClient((cmd, args) => {
			if (cmd === "SELECT") return "OK";
			if (cmd === "SCAN") return ["0", ["user:1", "user:2", "session:x", "barekey"]];
			return null;
		});
		const d = driver(client);
		await d.connect();
		const tables = await d.listTables("db0");
		expect(tables.map((t) => t.name).sort()).toEqual(["(root)", "session", "user"]);
		expect(tables.every((t) => t.kind === "table")).toBe(true);
	});

	it("describeTable returns the fixed key/type/ttl/value columns with key as PK", async () => {
		const { client } = fakeClient(() => null);
		const d = driver(client);
		await d.connect();
		const detail = await d.describeTable("db0", "user");
		expect(detail.columns.map((c) => c.name)).toEqual(["key", "type", "ttl", "value"]);
		expect(detail.columns.find((c) => c.name === "key")?.isPrimaryKey).toBe(true);
	});

	it("browseKeyspace scans a prefix and enriches each key with type/ttl/value", async () => {
		const { client } = fakeClient((cmd, args) => {
			if (cmd === "SELECT") return "OK";
			if (cmd === "SCAN") return ["7", ["user:1"]];
			if (cmd === "TYPE") return "string";
			if (cmd === "TTL") return -1;
			if (cmd === "GETRANGE") return "alice";
			return null;
		});
		const d = driver(client);
		await d.connect();
		const r = await d.browseKeyspace({ schema: "db0", prefix: "user", cursor: null, limit: 100, valuePreviewLimit: 20 });
		expect(r.rows).toEqual([{ key: "user:1", type: "string", ttl: -1, value: "alice" }]);
		expect(r.scanCursor).toBe("7");
	});
});
