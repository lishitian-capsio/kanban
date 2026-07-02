import { describe, expect, it } from "vitest";
import { shapeRedisReply } from "../../../src/db/driver/redis/redis-reply-shaper";

describe("shapeRedisReply", () => {
	it("scalar → one {value} row", () => {
		const r = shapeRedisReply("GET", "hello");
		expect(r.rows).toEqual([{ value: "hello" }]);
		expect(r.fields.map((f) => f.name)).toEqual(["value"]);
	});
	it("null → zero rows", () => {
		expect(shapeRedisReply("GET", null).rows).toEqual([]);
	});
	it("flat array → {index,value} rows", () => {
		const r = shapeRedisReply("SMEMBERS", ["a", "b"]);
		expect(r.rows).toEqual([{ index: 0, value: "a" }, { index: 1, value: "b" }]);
	});
	it("HGETALL object → {field,value} rows", () => {
		const r = shapeRedisReply("HGETALL", { name: "n", age: "3" });
		expect(r.rows).toEqual([{ field: "name", value: "n" }, { field: "age", value: "3" }]);
	});
	it("HGETALL RESP2 flat pair array → {field,value} rows", () => {
		const r = shapeRedisReply("HGETALL", ["name", "n", "age", "3"]);
		expect(r.rows).toEqual([{ field: "name", value: "n" }, { field: "age", value: "3" }]);
	});
	it("ZRANGE WITHSCORES pair array → {member,score} rows", () => {
		const r = shapeRedisReply("ZRANGE", ["m1", "1", "m2", "2"]);
		expect(r.rows).toEqual([{ member: "m1", score: "1" }, { member: "m2", score: "2" }]);
	});
	it("nested array element is JSON-stringified", () => {
		const r = shapeRedisReply("SCAN", [["a", "b"]]);
		expect(r.rows).toEqual([{ index: 0, value: '["a","b"]' }]);
	});
});
