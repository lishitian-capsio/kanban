import { describe, expect, it } from "bun:test";

import { __setJsonlEngineForTest, activeJsonlEngine, parseJsonl } from "../../src/fs/jsonl";

// Bun's runner is the only place `Bun.JSONL` exists (vitest runs under Node),
// so the native engine is proven here. `test/runtime/fs/jsonl.test.ts` covers
// the fallback under Node; this file asserts the native path is equivalent.

/** The reference behavior the wrapper must preserve: split + per-line JSON.parse. */
function reference(content: string): unknown[] {
	const out: unknown[] = [];
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		try {
			out.push(JSON.parse(line));
		} catch {
			// skip
		}
	}
	return out;
}

const CASES: string[] = [
	'{"a":1}\n{"a":2}\n',
	'{"a":1}\n{"a":2}',
	'{"a":1}\n{"a":2}\n{"a":',
	'{"a":1}\nnotjson\n{"a":2}\n',
	'notjson\nbad2\n{"a":3}\n',
	'{"a":1}\n\n  \n{"a":2}\n',
	'  {"a":1}  \n{"a":2}\n',
	"",
	"\n\n",
	'1\n"x"\n[1,2]\ntrue\n',
	'{"a":1}\nnotjson',
	'{"nested":{"b":[1,2,3]},"s":"a\\nb"}\n{"a":2}\n',
];

describe("parseJsonl (Bun native engine)", () => {
	it("auto-detects the bun engine under bun test", () => {
		expect(activeJsonlEngine()).toBe("bun");
	});

	it("matches the split-based reference on every edge case", () => {
		for (const content of CASES) {
			expect(parseJsonl(content)).toEqual(reference(content));
		}
	});

	it("the fallback engine agrees with the native engine", () => {
		__setJsonlEngineForTest("fallback");
		let fallbackResults: unknown[][];
		try {
			fallbackResults = CASES.map((content) => parseJsonl(content));
		} finally {
			__setJsonlEngineForTest(null);
		}
		const nativeResults = CASES.map((content) => parseJsonl(content));
		expect(nativeResults).toEqual(fallbackResults);
	});
});
