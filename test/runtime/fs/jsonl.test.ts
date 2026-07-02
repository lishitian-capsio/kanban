import { describe, expect, it } from "vitest";

import { __setJsonlEngineForTest, activeJsonlEngine, parseJsonl } from "../../../src/fs/jsonl";

// vitest runs under Node, where `Bun.JSONL` is absent, so these exercise the
// pure-JS fallback engine. The Bun-native engine is proven equivalent in
// `test/bun/jsonl.test.ts` (`bun test`).

describe("parseJsonl (fallback engine)", () => {
	it("auto-detects the fallback engine under Node vitest", () => {
		expect(activeJsonlEngine()).toBe("fallback");
	});

	it("parses one JSON value per line", () => {
		expect(parseJsonl('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("tolerates a missing trailing newline", () => {
		expect(parseJsonl('{"a":1}\n{"a":2}')).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("drops a torn trailing line (crash mid-write)", () => {
		expect(parseJsonl('{"a":1}\n{"a":2}\n{"a":')).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("skips a garbage middle line and continues", () => {
		expect(parseJsonl('{"a":1}\nnotjson\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("skips consecutive garbage lines", () => {
		expect(parseJsonl('notjson\nbad2\n{"a":3}\n')).toEqual([{ a: 3 }]);
	});

	it("skips blank and whitespace-only lines", () => {
		expect(parseJsonl('{"a":1}\n\n  \n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("tolerates leading/trailing whitespace around a value", () => {
		expect(parseJsonl('  {"a":1}  \n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("returns [] for empty or blank-only content", () => {
		expect(parseJsonl("")).toEqual([]);
		expect(parseJsonl("\n\n")).toEqual([]);
	});

	it("preserves scalar and array JSONL values", () => {
		expect(parseJsonl('1\n"x"\n[1,2]\ntrue\n')).toEqual([1, "x", [1, 2], true]);
	});

	it("honours the test engine override", () => {
		__setJsonlEngineForTest("fallback");
		try {
			expect(activeJsonlEngine()).toBe("fallback");
		} finally {
			__setJsonlEngineForTest(null);
		}
	});
});
