import { describe, expect, it } from "vitest";

import { base64ToBytes, safeFileSlug } from "./download";

describe("safeFileSlug", () => {
	it("lowercases and dashes non-alphanumerics", () => {
		expect(safeFileSlug("Requirements")).toBe("requirements");
		expect(safeFileSlug("My Notes & Stuff")).toBe("my-notes-stuff");
	});

	it("trims leading/trailing dashes and collapses runs", () => {
		expect(safeFileSlug("  --Hello--  ")).toBe("hello");
	});

	it("falls back to the given default when nothing survives", () => {
		expect(safeFileSlug("...", "vault")).toBe("vault");
		expect(safeFileSlug("")).toBe("file");
	});
});

describe("base64ToBytes", () => {
	it("decodes a base64 payload to its exact bytes", () => {
		// "hi" → base64 "aGk="
		expect(Array.from(base64ToBytes("aGk="))).toEqual([104, 105]);
	});

	it("round-trips arbitrary bytes through btoa", () => {
		const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
		const base64 = btoa(String.fromCharCode(...bytes));
		expect(Array.from(base64ToBytes(base64))).toEqual(Array.from(bytes));
	});

	it("decodes an empty payload to an empty array", () => {
		expect(base64ToBytes("")).toHaveLength(0);
	});
});
