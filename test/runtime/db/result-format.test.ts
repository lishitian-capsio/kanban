import { describe, expect, it } from "vitest";

import { formatDbCell } from "../../../src/db/result-format";

describe("formatDbCell", () => {
	it("passes strings through unchanged", () => {
		expect(formatDbCell("hello")).toBe("hello");
		expect(formatDbCell("")).toBe("");
	});

	it("maps null and undefined to null", () => {
		expect(formatDbCell(null)).toBeNull();
		expect(formatDbCell(undefined)).toBeNull();
	});

	it("stringifies numbers, booleans, and bigints", () => {
		expect(formatDbCell(42)).toBe("42");
		expect(formatDbCell(0)).toBe("0");
		expect(formatDbCell(true)).toBe("true");
		expect(formatDbCell(false)).toBe("false");
		expect(formatDbCell(9007199254740993n)).toBe("9007199254740993");
	});

	it("renders Date as an ISO string", () => {
		expect(formatDbCell(new Date("2024-01-02T03:04:05.000Z"))).toBe("2024-01-02T03:04:05.000Z");
	});

	it("base64-encodes binary buffers", () => {
		expect(formatDbCell(Buffer.from("abc"))).toBe(Buffer.from("abc").toString("base64"));
	});

	it("JSON-stringifies objects and arrays", () => {
		expect(formatDbCell({ a: 1 })).toBe('{"a":1}');
		expect(formatDbCell([1, 2])).toBe("[1,2]");
	});
});
