import { describe, expect, it } from "vitest";
import type { S3ClientFactory, S3ClientLike } from "../../../src/storage/s3-client";
import { defaultS3ClientFactory } from "../../../src/storage/s3-client";

describe("s3-client seam", () => {
	it("exposes a default factory without importing Bun at module load", () => {
		// Importing the module must not throw on Node/vitest (Bun.S3Client referenced lazily).
		expect(typeof defaultS3ClientFactory).toBe("function");
	});

	it("a fake factory satisfies S3ClientLike", async () => {
		const fake: S3ClientFactory = () =>
			({
				async list() {
					return { contents: [], isTruncated: false };
				},
				async stat() {
					return { size: 0, lastModified: new Date(0), etag: "e", type: "text/plain" };
				},
				async readBytes() {
					return { bytes: new Uint8Array(), truncated: false, contentType: "text/plain" };
				},
			}) satisfies S3ClientLike;
		const client = fake({ bucket: "b", virtualHostedStyle: false });
		expect((await client.list({})).isTruncated).toBe(false);
	});
});
