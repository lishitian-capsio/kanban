import { describe, expect, it } from "vitest";
import { buildRedisUrl } from "../../../src/db/driver/redis/redis-client";
import type { ConnectionConfig } from "../../../src/db/types";

const base: ConnectionConfig = { engine: "redis", host: "localhost", port: 6379 };

describe("buildRedisUrl", () => {
	it("builds a plain redis:// url with db index", () => {
		expect(buildRedisUrl({ ...base, database: "2" })).toBe("redis://localhost:6379/2");
	});
	it("defaults db to 0 and port to 6379", () => {
		expect(buildRedisUrl({ engine: "redis", host: "h" })).toBe("redis://h:6379/0");
	});
	it("uses rediss:// when ssl mode is not disable", () => {
		expect(buildRedisUrl({ ...base, ssl: { mode: "require" } })).toBe("rediss://localhost:6379/0");
	});
	it("embeds user:password credentials, url-encoded", () => {
		expect(buildRedisUrl({ ...base, user: "u", password: "p@ss word" })).toBe(
			"redis://u:p%40ss%20word@localhost:6379/0",
		);
	});
	it("uses a unix socket url when filePath is set", () => {
		expect(buildRedisUrl({ engine: "redis", filePath: "/var/run/redis.sock" })).toBe(
			"redis+unix:///var/run/redis.sock",
		);
	});
});
