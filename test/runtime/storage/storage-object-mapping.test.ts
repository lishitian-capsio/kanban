// test/runtime/storage/storage-object-mapping.test.ts
import { describe, expect, it } from "vitest";
import { basename, classifyContent, isTextKey, mapListResponse } from "../../../src/storage/storage-object-mapping";

describe("mapListResponse", () => {
	it("maps commonPrefixes to prefix entries and contents to object entries", () => {
		const out = mapListResponse("photos/", {
			commonPrefixes: [{ prefix: "photos/2026/" }],
			contents: [{ key: "photos/a.png", size: 1234, lastModified: "2026-07-02T00:00:00Z", eTag: "abc" }],
			isTruncated: true,
			nextContinuationToken: "TOKEN",
		});
		expect(out.entries).toEqual([
			{ key: "photos/2026/", name: "2026", kind: "prefix" },
			{ key: "photos/a.png", name: "a.png", kind: "object", size: 1234, lastModified: "2026-07-02T00:00:00Z", etag: "abc" },
		]);
		expect(out.isTruncated).toBe(true);
		expect(out.nextContinuationToken).toBe("TOKEN");
	});

	it("drops the folder placeholder object equal to the listing prefix", () => {
		const out = mapListResponse("photos/", {
			contents: [{ key: "photos/", size: 0 }],
			isTruncated: false,
		});
		expect(out.entries).toEqual([]);
	});
});

describe("basename", () => {
	it("returns the last segment, tolerating a trailing slash", () => {
		expect(basename("a/b/c.txt")).toBe("c.txt");
		expect(basename("a/b/")).toBe("b");
		expect(basename("root.txt")).toBe("root.txt");
	});
});

describe("classifyContent", () => {
	it("treats .ts as text despite its video mime", () => {
		expect(isTextKey("src/index.ts")).toBe(true);
		expect(classifyContent(new Uint8Array([0x61, 0x62]), "video/mp2t", "src/index.ts").binary).toBe(false);
	});
	it("flags NUL bytes as binary", () => {
		expect(classifyContent(new Uint8Array([0x00, 0x01]), "application/octet-stream", "blob.bin").binary).toBe(true);
	});
});
