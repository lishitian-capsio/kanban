import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	normalizeConnId,
	readStorageConnections,
	readStorageCredentials,
	resolveS3ClientOptions,
	writeStorageConnections,
	writeStorageCredentials,
} from "../../../src/storage/storage-connection-store";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "kanban-storage-store-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("storage connection store", () => {
	it("roundtrips sharded records and canonicalizes connId", async () => {
		const shardDir = join(dir, "storage-connections");
		await writeStorageConnections(shardDir, [
			{
				connId: "R2-Prod",
				label: "R2",
				endpoint: null,
				region: "auto",
				bucket: "assets",
				virtualHostedStyle: false,
				createdAt: "2026-07-02T00:00:00.000Z",
			},
		]);
		const records = await readStorageConnections(shardDir);
		expect(records).toHaveLength(1);
		expect(records[0]?.connId).toBe("r2-prod");
	});

	it("treats a missing credentials file as empty", async () => {
		const data = await readStorageCredentials(join(dir, "missing.json"));
		expect(data.credentials).toEqual({});
	});

	it("roundtrips credentials", async () => {
		const path = join(dir, "storage-credentials.json");
		await writeStorageCredentials(path, {
			credentials: { "r2-prod": { accessKeyId: "AK", secretAccessKey: "SK" } },
		});
		const data = await readStorageCredentials(path);
		expect(data.credentials["r2-prod"]?.secretAccessKey).toBe("SK");
	});

	it("merges record + secret into explicit client options", () => {
		const opts = resolveS3ClientOptions(
			{
				connId: "r2-prod",
				label: "R2",
				endpoint: "https://acct.r2.cloudflarestorage.com",
				region: null,
				bucket: "assets",
				virtualHostedStyle: false,
				createdAt: "2026-07-02T00:00:00.000Z",
			},
			{ accessKeyId: "AK", secretAccessKey: "SK" },
		);
		expect(opts).toMatchObject({
			bucket: "assets",
			endpoint: "https://acct.r2.cloudflarestorage.com",
			accessKeyId: "AK",
			secretAccessKey: "SK",
			virtualHostedStyle: false,
		});
		expect(opts.region).toBeUndefined();
	});

	it("normalizes ids by trim + lowercase", () => {
		expect(normalizeConnId("  R2-Prod ")).toBe("r2-prod");
	});
});
