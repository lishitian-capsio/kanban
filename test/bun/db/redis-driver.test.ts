import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { RedisDriver } from "../../../src/db/driver/redis/redis-driver";
import type { ConnectionConfig } from "../../../src/db/types";

const url = process.env.REDIS_TEST_URL;
const maybe = url ? describe : describe.skip;

maybe("RedisDriver (real connection)", () => {
	// Parse REDIS_TEST_URL into config, or pass host/port directly.
	const config: ConnectionConfig = { engine: "redis", host: "localhost", port: 6379, database: "0" };
	let driver: RedisDriver;

	beforeAll(async () => {
		driver = new RedisDriver(config);
		await driver.connect();
	});
	afterAll(async () => {
		await driver.disconnect();
	});

	it("pings and reports a version", async () => {
		const r = await driver.testConnection();
		expect(r.ok).toBe(true);
	});

	it("lists schemas (db0…)", async () => {
		const schemas = await driver.listSchemas();
		expect(schemas.some((s) => s.name === "db0")).toBe(true);
	});

	it("browses the keyspace", async () => {
		const r = await driver.browseKeyspace({ schema: "db0", prefix: "(root)", cursor: null, limit: 10, valuePreviewLimit: 32 });
		expect(Array.isArray(r.rows)).toBe(true);
	});

	it("refuses a write command", async () => {
		await expect(driver.query({ sql: "SET k v", readOnly: true })).rejects.toThrow();
	});
});
