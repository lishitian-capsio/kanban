import { describe, expect, it } from "vitest";
import { DbQueryError } from "../../../src/db/errors";
import { isReadOnlyRedisCommand, parseRedisCommandLine } from "../../../src/db/driver/redis/redis-commands";

describe("parseRedisCommandLine", () => {
	it("splits command and args, uppercasing the command", () => {
		expect(parseRedisCommandLine("hgetall user:1")).toEqual({ command: "HGETALL", args: ["user:1"] });
	});
	it("respects double-quoted args with spaces", () => {
		expect(parseRedisCommandLine('GET "a b"')).toEqual({ command: "GET", args: ["a b"] });
	});
	it("throws on an empty line", () => {
		expect(() => parseRedisCommandLine("   ")).toThrow(DbQueryError);
	});
});

describe("isReadOnlyRedisCommand", () => {
	it("allows GET and HGETALL (case-insensitive)", () => {
		expect(isReadOnlyRedisCommand("get")).toBe(true);
		expect(isReadOnlyRedisCommand("HGETALL")).toBe(true);
	});
	it("rejects writes and admin", () => {
		expect(isReadOnlyRedisCommand("SET")).toBe(false);
		expect(isReadOnlyRedisCommand("DEL")).toBe(false);
		expect(isReadOnlyRedisCommand("FLUSHALL")).toBe(false);
	});
});
