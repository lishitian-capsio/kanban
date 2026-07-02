/**
 * Smoke test for the `storage` tRPC sub-router dispatch.
 *
 * Regression guard for the naming-collision rename: the PUBLIC router key
 * `storage.listConnections` must dispatch to `workspaceApi.listStorageConnections`
 * (NOT `dbApi.listConnections`), and `storage.upsertConnection` must dispatch to
 * `workspaceApi.upsertStorageConnection`.
 */
import { describe, expect, it, vi } from "vitest";

import type { RuntimeStorageConnection, RuntimeStorageUpsertConnectionRequest } from "../../../src/core/api-contract";
import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { runtimeAppRouter } from "../../../src/trpc/app-router";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_SCOPE = { workspaceId: "ws-test", workspacePath: "/tmp/repo" };

const FAKE_CONN: RuntimeStorageConnection = {
	connId: "test-conn",
	label: "Test Bucket",
	endpoint: "https://s3.example.com",
	region: "us-east-1",
	bucket: "my-bucket",
	virtualHostedStyle: false,
	hasCredential: false,
	createdAt: "2026-07-02T00:00:00.000Z",
};

const UPSERT_INPUT: RuntimeStorageUpsertConnectionRequest = {
	label: "Test Bucket",
	endpoint: "https://s3.example.com",
	region: "us-east-1",
	bucket: "my-bucket",
	virtualHostedStyle: false,
};

function buildFakeCtx(): RuntimeTrpcContext {
	const listStorageConnections = vi.fn().mockResolvedValue({ connections: [] });
	const upsertStorageConnection = vi.fn().mockResolvedValue({ connection: FAKE_CONN });
	// DB api has its own listConnections — must NOT be called by storage.listConnections.
	const dbListConnections = vi.fn().mockResolvedValue({ connections: [] });

	return {
		requestedWorkspaceId: WORKSPACE_SCOPE.workspaceId,
		workspaceScope: WORKSPACE_SCOPE,
		workspaceApi: {
			listStorageConnections,
			upsertStorageConnection,
			// Stub out everything else the type requires.
			listConnections: vi.fn(),
			upsertConnection: vi.fn(),
			deleteConnection: vi.fn(),
			testConnection: vi.fn(),
			introspect: vi.fn(),
			browseTable: vi.fn(),
			updateRow: vi.fn(),
			insertRow: vi.fn(),
			deleteRow: vi.fn(),
			deleteStorageConnection: vi.fn(),
			testStorageConnection: vi.fn(),
			listObjects: vi.fn(),
			readObject: vi.fn(),
			statObject: vi.fn(),
			downloadObject: vi.fn(),
			loadGitSummary: vi.fn(),
			runGitSyncAction: vi.fn(),
			checkoutGitBranch: vi.fn(),
			discardGitChanges: vi.fn(),
			loadChanges: vi.fn(),
			loadArtifacts: vi.fn(),
			loadArtifactContent: vi.fn(),
			ensureWorktree: vi.fn(),
			deleteWorktree: vi.fn(),
			loadTaskContext: vi.fn(),
			searchFiles: vi.fn(),
			loadState: vi.fn(),
			listFiles: vi.fn(),
			getFile: vi.fn(),
			addFile: vi.fn(),
			updateFile: vi.fn(),
			deleteFile: vi.fn(),
			getFileBytes: vi.fn(),
			getFilePath: vi.fn(),
			listDocuments: vi.fn(),
			getDocument: vi.fn(),
			getDocumentLinks: vi.fn(),
			searchDocuments: vi.fn(),
			createDocument: vi.fn(),
			updateDocument: vi.fn(),
			deleteDocument: vi.fn(),
			exportDocument: vi.fn(),
			exportArchive: vi.fn(),
			listViews: vi.fn(),
			createView: vi.fn(),
			updateView: vi.fn(),
			deleteView: vi.fn(),
			getVaultSettings: vi.fn(),
			getGitUserIdentity: vi.fn(),
			setGitUserIdentity: vi.fn(),
			getGitRemote: vi.fn(),
			setGitRemote: vi.fn(),
			updateVaultSettings: vi.fn(),
			getBoardSyncStatus: vi.fn(),
			runBoardSyncAction: vi.fn(),
			setBoardAutoSync: vi.fn(),
			updateBoardBranch: vi.fn(),
			notifyStateUpdated: vi.fn(),
			saveState: vi.fn(),
			loadWorkspaceChanges: vi.fn(),
			loadGitLog: vi.fn(),
			loadGitRefs: vi.fn(),
			loadCommitDiff: vi.fn(),
		} as unknown as RuntimeTrpcContext["workspaceApi"],
		dbApi: {
			listConnections: dbListConnections,
			addConnection: vi.fn(),
			removeConnection: vi.fn(),
			testConnection: vi.fn(),
			listTables: vi.fn(),
			describeTable: vi.fn(),
			runQuery: vi.fn(),
			browseTable: vi.fn(),
		},
		runtimeApi: {} as unknown as RuntimeTrpcContext["runtimeApi"],
		workspaceFsApi: {} as unknown as RuntimeTrpcContext["workspaceFsApi"],
		projectsApi: {} as unknown as RuntimeTrpcContext["projectsApi"],
		hooksApi: { ingest: vi.fn() },
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storage tRPC router dispatch", () => {
	it("storage.listConnections dispatches to workspaceApi.listStorageConnections (not dbApi.listConnections)", async () => {
		const ctx = buildFakeCtx();
		const caller = runtimeAppRouter.createCaller(ctx);

		const result = await caller.storage.listConnections();

		expect(ctx.workspaceApi.listStorageConnections).toHaveBeenCalledWith(WORKSPACE_SCOPE);
		expect(ctx.dbApi.listConnections).not.toHaveBeenCalled();
		expect(result.connections).toEqual([]);
	});

	it("storage.upsertConnection dispatches to workspaceApi.upsertStorageConnection", async () => {
		const ctx = buildFakeCtx();
		const caller = runtimeAppRouter.createCaller(ctx);

		const result = await caller.storage.upsertConnection(UPSERT_INPUT);

		expect(ctx.workspaceApi.upsertStorageConnection).toHaveBeenCalledWith(WORKSPACE_SCOPE, UPSERT_INPUT);
		expect(result.connection).toMatchObject({ connId: FAKE_CONN.connId, bucket: FAKE_CONN.bucket });
	});
});
