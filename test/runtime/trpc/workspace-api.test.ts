import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary, RuntimeWorkspaceChangesResponse } from "../../../src/core/api-contract";

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const workspaceChangesMocks = vi.hoisted(() => ({
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
	getWorkspaceChangedPathsFromRef: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: vi.fn(),
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskWorkspaceInfo: vi.fn(),
	resolveTaskCwd: workspaceTaskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: workspaceChangesMocks.createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges: workspaceChangesMocks.getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs: workspaceChangesMocks.getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef: workspaceChangesMocks.getWorkspaceChangesFromRef,
	getWorkspaceChangedPathsFromRef: workspaceChangesMocks.getWorkspaceChangedPathsFromRef,
}));

import { createWorkspaceApi } from "../../../src/trpc/workspace-api";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createChangesResponse(): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: "/tmp/worktree",
		generatedAt: Date.now(),
		files: [],
	};
}

describe("createWorkspaceApi loadChanges", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockReset();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockReset();
		workspaceChangesMocks.getWorkspaceChanges.mockReset();
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockReset();
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockReset();

		workspaceTaskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChanges.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockResolvedValue(createChangesResponse());
	});

	it("shows the completed turn diff while awaiting review", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			boardSync: {
				getStatus: vi.fn(),
				runAction: vi.fn(),
				setAutoSyncPaused: vi.fn(),
				renameBranch: vi.fn(),
			},
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "1111111",
			toRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
	});

	it("tracks the current turn from the latest checkpoint while running", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "running",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			boardSync: {
				getStatus: vi.fn(),
				runAction: vi.fn(),
				setAutoSyncPaused: vi.fn(),
				renameBranch: vi.fn(),
			},
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("uses native pi session checkpoints when terminal summaries are unavailable", async () => {
		const terminalManager = {
			getSummary: vi.fn(() => null),
		};
		const piTaskSessionService = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 3,
						ref: "refs/kanban/checkpoints/task-1/turn/3",
						commit: "3333333",
						createdAt: 3,
					},
					previousTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			boardSync: {
				getStatus: vi.fn(),
				runAction: vi.fn(),
				setAutoSyncPaused: vi.fn(),
				renameBranch: vi.fn(),
			},
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(piTaskSessionService.getSummary).toHaveBeenCalledWith("task-1");
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
			toRef: "3333333",
		});
	});

	it("prefers the newer live pi summary over a stale terminal summary", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					agentId: "claude",
					updatedAt: 10,
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "terminal-2",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "terminal-1",
						createdAt: 1,
					},
				}),
			),
		};
		const piTaskSessionService = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					agentId: "pi",
					updatedAt: 20,
					latestTurnCheckpoint: {
						turn: 3,
						ref: "refs/kanban/checkpoints/task-1/turn/3",
						commit: "cline-3",
						createdAt: 3,
					},
					previousTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "cline-2",
						createdAt: 2,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedPiTaskSessionService: vi.fn(async () => piTaskSessionService as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			boardSync: {
				getStatus: vi.fn(),
				runAction: vi.fn(),
				setAutoSyncPaused: vi.fn(),
				renameBranch: vi.fn(),
			},
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "cline-2",
			toRef: "cline-3",
		});
	});

	it("returns an empty diff when the task worktree does not exist yet", async () => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(emptyResponse);

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			getScopedPiTaskSessionService: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			boardSync: {
				getStatus: vi.fn(),
				runAction: vi.fn(),
				setAutoSyncPaused: vi.fn(),
				renameBranch: vi.fn(),
			},
		});

		const response = await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.createEmptyWorkspaceChangesResponse).toHaveBeenCalledWith("/tmp/repo");
		expect(workspaceChangesMocks.getWorkspaceChanges).not.toHaveBeenCalled();
	});
});

describe("createWorkspaceApi file library", () => {
	let repoPath: string;
	let broadcastRuntimeWorkspaceStateUpdated: ReturnType<typeof vi.fn>;

	function createApi() {
		broadcastRuntimeWorkspaceStateUpdated = vi.fn();
		return createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			getScopedPiTaskSessionService: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated,
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			boardSync: {
				getStatus: vi.fn(),
				runAction: vi.fn(),
				setAutoSyncPaused: vi.fn(),
				renameBranch: vi.fn(),
			},
		});
	}

	const scope = () => ({ workspaceId: "workspace-1", workspacePath: repoPath });

	beforeEach(async () => {
		repoPath = await mkdtemp(join(tmpdir(), "kanban-workspace-api-files-"));
	});

	afterEach(async () => {
		await rm(repoPath, { recursive: true, force: true });
	});

	it("decodes base64 content on add and lists it back, broadcasting an update", async () => {
		const api = createApi();
		const data = Buffer.from("vision bytes").toString("base64");

		const added = await api.addFile(scope(), { name: "img.png", data, mime: "image/png" });
		expect(added.file).toMatchObject({ name: "img.png", mime: "image/png", category: "image" });
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith("workspace-1", repoPath);

		const listed = await api.listFiles(scope());
		expect(listed.files).toHaveLength(1);
		expect(listed.files[0]?.id).toBe(added.file.id);
	});

	it("returns base64 bytes and a repo-relative path for a stored file", async () => {
		const api = createApi();
		const original = Buffer.from("hello");
		const added = await api.addFile(scope(), { name: "a.txt", data: original.toString("base64") });

		const bytes = await api.getFileBytes(scope(), { id: added.file.id });
		expect(bytes.data).toBe(original.toString("base64"));
		expect(bytes.mimeType).toBe("text/plain");

		const path = await api.getFilePath(scope(), { id: added.file.id });
		expect(path.relativePath).toBe(join(".kanban", "files", "blobs", added.file.id, "a.txt"));
	});

	it("returns null shapes for unknown ids", async () => {
		const api = createApi();
		expect((await api.getFile(scope(), { id: "nope" })).file).toBeNull();
		expect(await api.getFileBytes(scope(), { id: "nope" })).toEqual({ file: null, data: null, mimeType: null });
		expect(await api.getFilePath(scope(), { id: "nope" })).toEqual({
			file: null,
			absolutePath: null,
			relativePath: null,
		});
	});

	it("renames and deletes files", async () => {
		const api = createApi();
		const added = await api.addFile(scope(), { name: "old.txt", data: Buffer.from("x").toString("base64") });

		const renamed = await api.updateFile(scope(), { id: added.file.id, name: "new.txt" });
		expect(renamed.file.name).toBe("new.txt");

		expect(await api.deleteFile(scope(), { id: added.file.id })).toEqual({ deleted: true });
		expect(await api.deleteFile(scope(), { id: added.file.id })).toEqual({ deleted: false });
		expect((await api.listFiles(scope())).files).toHaveLength(0);
	});
});

describe("createWorkspaceApi vault documents", () => {
	let repoPath: string;
	let broadcastRuntimeWorkspaceStateUpdated: ReturnType<typeof vi.fn>;

	// The vault store writes to the real temp `repoPath`; the session deps are
	// stubbed because vault-document operations never touch a transcript.
	function createApi() {
		broadcastRuntimeWorkspaceStateUpdated = vi.fn();
		return createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(
				async () => ({ loadTaskSessionMessages: vi.fn(async () => []) }) as never,
			),
			broadcastRuntimeWorkspaceStateUpdated: broadcastRuntimeWorkspaceStateUpdated as never,
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			boardSync: {
				getStatus: vi.fn(),
				runAction: vi.fn(),
				setAutoSyncPaused: vi.fn(),
				renameBranch: vi.fn(),
			},
		});
	}

	const scope = () => ({ workspaceId: "workspace-1", workspacePath: repoPath });

	beforeEach(async () => {
		repoPath = await mkdtemp(join(tmpdir(), "kanban-workspace-api-vault-"));
	});

	afterEach(async () => {
		await rm(repoPath, { recursive: true, force: true });
	});

	it("creates, lists (filtered by type), gets, and deletes documents, broadcasting on each mutation", async () => {
		const api = createApi();

		const created = await api.createDocument(scope(), {
			type: "requirement",
			title: "Doc A",
			body: "Body A",
			frontmatter: { priority: "high" },
		});
		expect(created.document).toMatchObject({ type: "requirement", title: "Doc A", body: "Body A" });
		expect(created.document.frontmatter).toMatchObject({ status: "proposed", priority: "high" });
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith("workspace-1", repoPath);

		await api.createDocument(scope(), { type: "note", title: "A note" });

		expect((await api.listDocuments(scope(), { type: "requirement" })).documents).toHaveLength(1);
		expect((await api.listDocuments(scope(), {})).documents).toHaveLength(2);

		const got = await api.getDocument(scope(), { id: created.document.id });
		expect(got.document?.body).toBe("Body A");

		const updated = await api.updateDocument(scope(), {
			id: created.document.id,
			frontmatter: { status: "clarified" },
		});
		expect(updated.document.frontmatter.status).toBe("clarified");

		broadcastRuntimeWorkspaceStateUpdated.mockClear();
		expect((await api.deleteDocument(scope(), { id: created.document.id })).deleted).toBe(true);
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith("workspace-1", repoPath);

		// Deleting an unknown id does not broadcast.
		broadcastRuntimeWorkspaceStateUpdated.mockClear();
		expect((await api.deleteDocument(scope(), { id: "nope" })).deleted).toBe(false);
		expect(broadcastRuntimeWorkspaceStateUpdated).not.toHaveBeenCalled();
	});

	it("searches the scanned doc store, ranking title hits over body hits and honoring the type filter", async () => {
		const api = createApi();

		// Distinct match tiers keep the ordering independent of write timestamps:
		// exact title > word-boundary title > body-only.
		await api.createDocument(scope(), { type: "requirement", title: "login", body: "unrelated" });
		await api.createDocument(scope(), { type: "requirement", title: "Signup flow", body: "add a login throttle" });
		await api.createDocument(scope(), { type: "note", title: "Improve login page" });

		const all = await api.searchDocuments(scope(), { query: "login" });
		expect(all.results.map((r) => r.title)).toEqual(["login", "Improve login page", "Signup flow"]);
		expect(all.results[0].field).toBe("title");

		const requirementsOnly = await api.searchDocuments(scope(), { query: "login", type: "requirement" });
		expect(requirementsOnly.results.map((r) => r.type)).toEqual(["requirement", "requirement"]);

		const none = await api.searchDocuments(scope(), { query: "   " });
		expect(none.results).toEqual([]);
	});

	it("exports one document's raw markdown and packs many into a zip mirroring the on-disk tree", async () => {
		const api = createApi();
		const req = await api.createDocument(scope(), { type: "requirement", title: "Export me", body: "the body" });
		const note = await api.createDocument(scope(), { type: "note", title: "Second" });

		const single = await api.exportDocument(scope(), { id: req.document.id });
		expect(single.document?.fileName).toBe(`export-me-${req.document.id}.md`);
		expect(single.document?.content).toContain("_id:");
		expect(single.document?.content).toContain("the body");
		expect((await api.exportDocument(scope(), { id: "nope" })).document).toBeNull();

		const archive = await api.exportArchive(scope(), { ids: [req.document.id, note.document.id] });
		expect(archive.documentCount).toBe(2);
		const zip = await JSZip.loadAsync(archive.data, { base64: true });
		const files = Object.values(zip.files)
			.filter((file) => !file.dir)
			.map((file) => file.name)
			.sort();
		expect(files).toEqual([
			`docs/note/second-${note.document.id}.md`,
			`docs/requirement/export-me-${req.document.id}.md`,
		]);
	});
});

describe("createWorkspaceApi vault settings", () => {
	let repoPath: string;
	let broadcastRuntimeWorkspaceStateUpdated: ReturnType<typeof vi.fn>;

	function createApi() {
		broadcastRuntimeWorkspaceStateUpdated = vi.fn();
		return createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(
				async () => ({ loadTaskSessionMessages: vi.fn(async () => []) }) as never,
			),
			broadcastRuntimeWorkspaceStateUpdated: broadcastRuntimeWorkspaceStateUpdated as never,
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			boardSync: {
				getStatus: vi.fn(),
				runAction: vi.fn(),
				setAutoSyncPaused: vi.fn(),
				renameBranch: vi.fn(),
			},
		});
	}

	const scope = () => ({ workspaceId: "workspace-1", workspacePath: repoPath });

	beforeEach(async () => {
		repoPath = await mkdtemp(join(tmpdir(), "kanban-workspace-api-vault-settings-"));
	});

	afterEach(async () => {
		await rm(repoPath, { recursive: true, force: true });
	});

	it("defaults to vaultMode off, then round-trips an update and broadcasts", async () => {
		const api = createApi();

		expect((await api.getVaultSettings(scope())).settings).toEqual({ vaultMode: "off" });

		const updated = await api.updateVaultSettings(scope(), { vaultMode: "managed" });
		expect(updated.settings).toEqual({ vaultMode: "managed" });
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith("workspace-1", repoPath);

		expect((await api.getVaultSettings(scope())).settings).toEqual({ vaultMode: "managed" });

		const stepped = await api.updateVaultSettings(scope(), { vaultMode: "cli-only" });
		expect(stepped.settings).toEqual({ vaultMode: "cli-only" });
		expect((await api.getVaultSettings(scope())).settings).toEqual({ vaultMode: "cli-only" });

		const reverted = await api.updateVaultSettings(scope(), { vaultMode: "off" });
		expect(reverted.settings).toEqual({ vaultMode: "off" });
		expect((await api.getVaultSettings(scope())).settings).toEqual({ vaultMode: "off" });
	});
});

describe("createWorkspaceApi loadArtifacts", () => {
	function createApi() {
		return createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			getScopedPiTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			boardSync: {
				getStatus: vi.fn(),
				runAction: vi.fn(),
				setAutoSyncPaused: vi.fn(),
				renameBranch: vi.fn(),
			},
		});
	}

	beforeEach(() => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockReset();
		workspaceChangesMocks.getWorkspaceChangedPathsFromRef.mockReset();
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.getWorkspaceChangedPathsFromRef.mockResolvedValue([]);
	});

	it("detects artifacts from changes between the base ref and the worktree", async () => {
		workspaceChangesMocks.getWorkspaceChangedPathsFromRef.mockResolvedValue([
			{ path: "docs/plan/feature.md", status: "added" },
			{ path: "src/index.ts", status: "modified" },
			{ path: "out/report.json", status: "modified" },
		]);

		const result = await createApi().loadArtifacts(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main" },
		);

		expect(workspaceChangesMocks.getWorkspaceChangedPathsFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "main",
		});
		expect(result.artifacts.map((a) => a.path)).toEqual(["out/report.json", "docs/plan/feature.md"]);
		expect(result.artifacts.find((a) => a.path === "docs/plan/feature.md")).toMatchObject({
			type: "plan",
			status: "new",
			previewKind: "markdown",
		});
	});

	it("returns an empty list when the task worktree is missing", async () => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const result = await createApi().loadArtifacts(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main" },
		);

		expect(result.artifacts).toEqual([]);
		expect(workspaceChangesMocks.getWorkspaceChangedPathsFromRef).not.toHaveBeenCalled();
	});
});
