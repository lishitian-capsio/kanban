// test/runtime/storage/s3-service.test.ts
import { describe, expect, it } from "vitest";
import type { S3ClientLike } from "../../../src/storage/s3-client";
import { StorageService } from "../../../src/storage/s3-service";
import type { StorageConnectionRecord } from "../../../src/storage/storage-connection-record";

const record: StorageConnectionRecord = {
	connId: "r2",
	label: "R2",
	endpoint: null,
	region: null,
	bucket: "assets",
	virtualHostedStyle: false,
	createdAt: "2026-07-02T00:00:00.000Z",
};

function serviceWith(client: Partial<S3ClientLike>): StorageService {
	return new StorageService({
		createClient: () => client as S3ClientLike,
		loadConnection: async () => record,
		loadCredential: async () => ({ accessKeyId: "AK", secretAccessKey: "SK" }),
	});
}

describe("StorageService", () => {
	it("listObjects always uses delimiter '/' and maps entries", async () => {
		let seen: unknown;
		const svc = serviceWith({
			async list(input) {
				seen = input;
				return { commonPrefixes: [{ prefix: "a/" }], contents: [{ key: "x.txt", size: 3 }], isTruncated: false };
			},
		});
		const out = await svc.listObjects("r2", { prefix: "" });
		expect(seen).toMatchObject({ delimiter: "/", prefix: "" });
		expect(out.entries.map((e) => e.kind)).toEqual(["prefix", "object"]);
	});

	it("readObject returns utf8 text under the cap", async () => {
		const svc = serviceWith({
			async readBytes() {
				return { bytes: new TextEncoder().encode("hello"), truncated: false, contentType: "text/plain" };
			},
			async stat() {
				return { size: 5, lastModified: new Date(0), etag: "e", type: "text/plain" };
			},
		});
		const out = await svc.readObject("r2", "greeting.txt");
		expect(out).toMatchObject({ encoding: "utf8", content: "hello", binary: false, tooLarge: false });
	});

	it("readObject base64-encodes binary content", async () => {
		const svc = serviceWith({
			async readBytes() {
				return { bytes: new Uint8Array([0, 1, 2]), truncated: false, contentType: "application/octet-stream" };
			},
			async stat() {
				return { size: 3, lastModified: new Date(0), etag: "e", type: "application/octet-stream" };
			},
		});
		const out = await svc.readObject("r2", "blob.bin");
		expect(out.encoding).toBe("base64");
		expect(out.binary).toBe(true);
		expect(out.content).toBe(Buffer.from([0, 1, 2]).toString("base64"));
	});

	it("readObject flags tooLarge and returns no content when the object exceeds the cap", async () => {
		const svc = serviceWith({
			async readBytes(_key, maxBytes) {
				return { bytes: new Uint8Array(maxBytes), truncated: true, contentType: "text/plain" };
			},
			async stat() {
				return { size: 999_999_999, lastModified: new Date(0), etag: "e", type: "text/plain" };
			},
		});
		const out = await svc.readObject("r2", "big.txt");
		expect(out.tooLarge).toBe(true);
		expect(out.content).toBeNull();
	});

	it("testConnection reports ok on a successful probe", async () => {
		const svc = serviceWith({
			async list() {
				return { contents: [], isTruncated: false };
			},
		});
		const out = await svc.testConnection("r2");
		expect(out.ok).toBe(true);
		expect(out.error).toBeNull();
	});

	it("testConnection reports the error message on failure", async () => {
		const svc = serviceWith({
			async list() {
				throw new Error("AccessDenied");
			},
		});
		const out = await svc.testConnection("r2");
		expect(out.ok).toBe(false);
		expect(out.error).toContain("AccessDenied");
	});

	it("exposes no write/delete/presign methods (read-only is structural)", () => {
		const svc = serviceWith({});
		expect((svc as unknown as Record<string, unknown>).presign).toBeUndefined();
		expect((svc as unknown as Record<string, unknown>).deleteObject).toBeUndefined();
		expect((svc as unknown as Record<string, unknown>).writeObject).toBeUndefined();
	});
});
