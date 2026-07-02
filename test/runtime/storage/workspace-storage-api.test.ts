import { describe, expect, it } from "vitest";
import { toRuntimeStorageConnection } from "../../../src/trpc/workspace-storage-api";

describe("toRuntimeStorageConnection", () => {
	it("maps a record + credential flag to the wire connection", () => {
		const conn = toRuntimeStorageConnection(
			{
				connId: "r2",
				label: "R2",
				endpoint: "https://x.r2.cloudflarestorage.com",
				region: null,
				bucket: "assets",
				virtualHostedStyle: false,
				createdAt: "2026-07-02T00:00:00.000Z",
			},
			true,
		);
		expect(conn).toMatchObject({ connId: "r2", bucket: "assets", hasCredential: true });
	});
});
