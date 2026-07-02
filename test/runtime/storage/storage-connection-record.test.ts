import { describe, expect, it } from "vitest";
import {
	storageConnectionRecordSchema,
	storageCredentialSchema,
} from "../../../src/storage/storage-connection-record";

describe("storageConnectionRecordSchema", () => {
	it("defaults virtualHostedStyle to false and keeps nullable metadata", () => {
		const record = storageConnectionRecordSchema.parse({
			connId: "r2-prod",
			label: "R2 prod",
			endpoint: "https://acct.r2.cloudflarestorage.com",
			region: null,
			bucket: "assets",
			createdAt: "2026-07-02T00:00:00.000Z",
		});
		expect(record.virtualHostedStyle).toBe(false);
		expect(record.region).toBeNull();
		expect(record.bucket).toBe("assets");
	});

	it("rejects an empty bucket", () => {
		expect(() =>
			storageConnectionRecordSchema.parse({
				connId: "x",
				label: "x",
				endpoint: null,
				region: null,
				bucket: "",
				createdAt: "2026-07-02T00:00:00.000Z",
			}),
		).toThrow();
	});

	it("parses a credential with optional session token", () => {
		const cred = storageCredentialSchema.parse({ accessKeyId: "AK", secretAccessKey: "SK" });
		expect(cred.sessionToken).toBeUndefined();
	});
});
