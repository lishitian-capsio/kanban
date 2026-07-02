import { describe, expect, it, vi } from "vitest";
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

// ---------------------------------------------------------------------------
// Credential merge logic tests
// ---------------------------------------------------------------------------
// We test the merge callback by capturing the mutator function that
// upsertConnection passes to mutateStorageCredential and invoking it
// directly with a fake current value.
// ---------------------------------------------------------------------------

const stateMocks = vi.hoisted(() => ({
	loadWorkspaceStorageConnections: vi.fn(),
	mutateWorkspaceStorageConnections: vi.fn(),
	loadStorageCredential: vi.fn(),
	mutateStorageCredential: vi.fn(),
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	loadWorkspaceStorageConnections: stateMocks.loadWorkspaceStorageConnections,
	mutateWorkspaceStorageConnections: stateMocks.mutateWorkspaceStorageConnections,
	loadStorageCredential: stateMocks.loadStorageCredential,
	mutateStorageCredential: stateMocks.mutateStorageCredential,
}));

vi.mock("../../../src/workspace/workspace-storage-service.js", () => ({
	getWorkspaceStorageService: vi.fn(),
}));

import { createWorkspaceStorageApi } from "../../../src/trpc/workspace-storage-api";
import type { RuntimeStorageUpsertConnectionRequest } from "../../../src/core/api-contract";
import type { RuntimeTrpcWorkspaceScope } from "../../../src/trpc/app-router";

const SCOPE = { workspaceId: "ws-test" } as RuntimeTrpcWorkspaceScope;

const FAKE_CONN_RECORD = {
	connId: "test-conn",
	label: "Test",
	endpoint: "https://s3.example.com",
	region: "us-east-1",
	bucket: "my-bucket",
	virtualHostedStyle: false,
	createdAt: "2026-07-02T00:00:00.000Z",
};

const BASE_INPUT: RuntimeStorageUpsertConnectionRequest = {
	connId: "test-conn",
	label: "Test",
	endpoint: "https://s3.example.com",
	region: "us-east-1",
	bucket: "my-bucket",
	virtualHostedStyle: false,
};

type StoredCred = { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined;

/**
 * Sets up mocks and calls upsertConnection with the given input.
 * Returns the result of invoking the captured mutateStorageCredential
 * callback with `currentCred`.  Returns "NOT_CALLED" when
 * mutateStorageCredential was never invoked (credential unchanged).
 */
async function captureMerge(
	input: RuntimeStorageUpsertConnectionRequest,
	currentCred: StoredCred,
): Promise<StoredCred | "NOT_CALLED"> {
	stateMocks.loadWorkspaceStorageConnections.mockResolvedValue([]);
	stateMocks.mutateWorkspaceStorageConnections.mockImplementation(
		async (_id: string, fn: (cur: typeof FAKE_CONN_RECORD[]) => typeof FAKE_CONN_RECORD[]) => {
			fn([]);
			return [FAKE_CONN_RECORD];
		},
	);
	stateMocks.loadStorageCredential.mockResolvedValue(undefined);

	let captured: ((cur: StoredCred) => StoredCred) | undefined;
	stateMocks.mutateStorageCredential.mockImplementation(
		async (_id: string, fn: (cur: StoredCred) => StoredCred) => {
			captured = fn;
		},
	);

	await createWorkspaceStorageApi().upsertConnection(SCOPE, input);

	if (!captured) {
		return "NOT_CALLED";
	}
	return captured(currentCred);
}

describe("upsertConnection credential merge", () => {
	it("1. keep: omitting both key fields does not call mutateStorageCredential", async () => {
		stateMocks.loadWorkspaceStorageConnections.mockResolvedValue([]);
		stateMocks.mutateWorkspaceStorageConnections.mockImplementation(
			async (_id: string, fn: (cur: typeof FAKE_CONN_RECORD[]) => typeof FAKE_CONN_RECORD[]) => {
				fn([]);
				return [FAKE_CONN_RECORD];
			},
		);
		stateMocks.loadStorageCredential.mockResolvedValue(undefined);
		stateMocks.mutateStorageCredential.mockResolvedValue(undefined);

		await createWorkspaceStorageApi().upsertConnection(SCOPE, {
			...BASE_INPUT,
			// accessKeyId and secretAccessKey intentionally omitted
		});

		expect(stateMocks.mutateStorageCredential).not.toHaveBeenCalled();
	});

	it("2. set: both keys non-empty → stored credential has those exact keys", async () => {
		const result = await captureMerge(
			{ ...BASE_INPUT, accessKeyId: "AKIANEW", secretAccessKey: "newSecret" },
			{ accessKeyId: "AKIAOLD", secretAccessKey: "oldSecret" },
		);
		expect(result).toMatchObject({ accessKeyId: "AKIANEW", secretAccessKey: "newSecret" });
	});

	it("3. clear: both keys null → mutate returns undefined (clears credential)", async () => {
		const result = await captureMerge(
			{ ...BASE_INPUT, accessKeyId: null, secretAccessKey: null },
			{ accessKeyId: "AKIAOLD", secretAccessKey: "oldSecret" },
		);
		expect(result).toBeUndefined();
	});

	it("3b. clear: both keys empty string → mutate returns undefined (clears credential)", async () => {
		const result = await captureMerge(
			{ ...BASE_INPUT, accessKeyId: "", secretAccessKey: "" },
			{ accessKeyId: "AKIAOLD", secretAccessKey: "oldSecret" },
		);
		expect(result).toBeUndefined();
	});

	it("4. partial-blank (the bug): blank accessKeyId falls back to current; non-blank secretAccessKey is stored", async () => {
		const result = await captureMerge(
			{ ...BASE_INPUT, accessKeyId: "", secretAccessKey: "new-secret" },
			{ accessKeyId: "OLD", secretAccessKey: "OLDS" },
		);
		expect(result).toMatchObject({ accessKeyId: "OLD", secretAccessKey: "new-secret" });
	});
});
