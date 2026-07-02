import { describe, expect, it } from "vitest";
import {
	runtimeStorageEntrySchema,
	runtimeStorageListResponseSchema,
	runtimeStorageUpsertConnectionRequestSchema,
} from "../../../src/core/api-contract";

describe("storage contract", () => {
	it("parses a prefix entry", () => {
		expect(runtimeStorageEntrySchema.parse({ key: "a/", name: "a", kind: "prefix" }).kind).toBe("prefix");
	});
	it("parses a list response with a continuation token", () => {
		const out = runtimeStorageListResponseSchema.parse({
			prefix: "",
			entries: [{ key: "x.txt", name: "x.txt", kind: "object", size: 3 }],
			isTruncated: true,
			nextContinuationToken: "T",
		});
		expect(out.entries).toHaveLength(1);
	});
	it("accepts null secrets in the upsert request (clear semantics)", () => {
		const out = runtimeStorageUpsertConnectionRequestSchema.parse({
			label: "R2",
			endpoint: null,
			region: null,
			bucket: "assets",
			virtualHostedStyle: false,
			accessKeyId: null,
			secretAccessKey: null,
		});
		expect(out.accessKeyId).toBeNull();
	});
});
