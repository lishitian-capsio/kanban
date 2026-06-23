import { TRPCError } from "@trpc/server";
import type { PiTaskSessionService } from "../agent-sdk/kanban/pi-task-session-service";
import type {
	RuntimeArtifactsResponse,
	RuntimeBoardBranchUpdateResponse,
	RuntimeBoardSyncAction,
	RuntimeBoardSyncActionResponse,
	RuntimeBoardSyncStatus,
	RuntimeGitCheckoutResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceChangesMode,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	parseGitCheckoutRequest,
	parseWorktreeDeleteRequest,
	parseWorktreeEnsureRequest,
} from "../core/api-validation";
import { FileLibraryStore } from "../files/file-library-store";
import { saveWorkspaceState, WorkspaceStateConflictError } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { SavedViewStore } from "../vault/saved-view-store";
import { VaultDocumentStore } from "../vault/vault-document-store";
import { buildVaultZipBase64 } from "../vault/vault-export";
import { VaultSettingsStore } from "../vault/vault-settings-store";
import { readArtifactContent } from "../workspace/artifact-content";
import { detectArtifacts } from "../workspace/artifact-detection";
import {
	createEmptyWorkspaceChangesResponse,
	getWorkspaceChangedPathsFromRef,
	getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef,
} from "../workspace/get-workspace-changes";
import { getCommitDiff, getGitLog, getGitRefs } from "../workspace/git-history";
import { discardGitChanges, getGitSyncSummary, runGitCheckoutAction, runGitSyncAction } from "../workspace/git-sync";
import { readGitUserIdentity, writeGitUserIdentity } from "../workspace/git-utils";
import { searchWorkspaceFiles } from "../workspace/search-workspace-files";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspaceInfo,
	resolveTaskCwd,
} from "../workspace/task-worktree";
import type { RuntimeTrpcContext } from "./app-router";
import { createWorkspaceDbApi } from "./workspace-db-api";

export interface CreateWorkspaceApiDependencies {
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	getScopedPiTaskSessionService?: (scope: {
		workspaceId: string;
		workspacePath: string;
	}) => Promise<PiTaskSessionService>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	/** Board-branch sync operations, backed by the process-wide board sync service. */
	boardSync: BoardSyncApi;
}

/** A workspace scope reduced to what the board sync service needs to build its target. */
export interface BoardSyncApiScope {
	workspaceId: string;
	workspacePath: string;
}

export interface BoardSyncApi {
	getStatus: (scope: BoardSyncApiScope) => Promise<RuntimeBoardSyncStatus>;
	runAction: (scope: BoardSyncApiScope, action: RuntimeBoardSyncAction) => Promise<RuntimeBoardSyncActionResponse>;
	setAutoSyncPaused: (scope: BoardSyncApiScope, paused: boolean) => Promise<RuntimeBoardSyncStatus>;
	renameBranch: (scope: BoardSyncApiScope, branch: string) => Promise<RuntimeBoardBranchUpdateResponse>;
}

function normalizeOptionalTaskWorkspaceScopeInput(
	input: { taskId: string; baseRef: string } | null,
): { taskId: string; baseRef: string } | null {
	if (!input) {
		return null;
	}
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId || !baseRef) {
		throw new Error("baseRef query parameter requires taskId.");
	}
	return {
		taskId,
		baseRef,
	};
}

function normalizeRequiredTaskWorkspaceScopeInput(input: {
	taskId: string;
	baseRef: string;
	mode?: RuntimeWorkspaceChangesMode;
}): {
	taskId: string;
	baseRef: string;
	mode: RuntimeWorkspaceChangesMode;
} {
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId) {
		throw new Error("Missing taskId query parameter.");
	}
	if (!baseRef) {
		throw new Error("Missing baseRef query parameter.");
	}
	const mode: RuntimeWorkspaceChangesMode = input.mode ?? "working_copy";
	return {
		taskId,
		baseRef,
		mode,
	};
}

function isActiveTaskSessionState(summary: RuntimeTaskSessionSummary | null): boolean {
	return summary?.state === "running" || summary?.state === "awaiting_review";
}

function selectLastTurnSummary(
	terminalSummary: RuntimeTaskSessionSummary | null,
	serviceSummary: RuntimeTaskSessionSummary | null,
): RuntimeTaskSessionSummary | null {
	if (!terminalSummary) {
		return serviceSummary;
	}
	if (!serviceSummary) {
		return terminalSummary;
	}
	const terminalIsActive = isActiveTaskSessionState(terminalSummary);
	const serviceIsActive = isActiveTaskSessionState(serviceSummary);
	if (terminalIsActive !== serviceIsActive) {
		return serviceIsActive ? serviceSummary : terminalSummary;
	}
	if (terminalSummary.updatedAt !== serviceSummary.updatedAt) {
		return terminalSummary.updatedAt > serviceSummary.updatedAt ? terminalSummary : serviceSummary;
	}
	if (serviceSummary.agentId === "pi" && terminalSummary.agentId !== "pi") {
		return serviceSummary;
	}
	return terminalSummary;
}

function createEmptyGitSummaryErrorResponse(error: unknown): RuntimeGitSummaryResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		error: message,
	};
}

function createEmptyGitSyncErrorResponse(action: RuntimeGitSyncAction, error: unknown): RuntimeGitSyncResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		action,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitCheckoutErrorResponse(error: unknown): RuntimeGitCheckoutResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		branch: "",
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitDiscardErrorResponse(error: unknown): RuntimeGitDiscardResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function isMissingTaskWorktreeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return error.message.startsWith("Task worktree not found for task ");
}

export function createWorkspaceApi(deps: CreateWorkspaceApiDependencies): RuntimeTrpcContext["workspaceApi"] {
	return {
		...createWorkspaceDbApi(),
		loadGitSummary: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let summaryCwd = workspaceScope.workspacePath;
				if (taskScope) {
					summaryCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
					});
				}
				const summary = await getGitSyncSummary(summaryCwd);
				return {
					ok: true,
					summary,
				} satisfies RuntimeGitSummaryResponse;
			} catch (error) {
				return createEmptyGitSummaryErrorResponse(error);
			}
		},
		runGitSyncAction: async (workspaceScope, input) => {
			try {
				return await runGitSyncAction({
					cwd: workspaceScope.workspacePath,
					action: input.action,
				});
			} catch (error) {
				return createEmptyGitSyncErrorResponse(input.action, error);
			}
		},
		checkoutGitBranch: async (workspaceScope, input) => {
			try {
				const body = parseGitCheckoutRequest(input);
				const response = await runGitCheckoutAction({
					cwd: workspaceScope.workspacePath,
					branch: body.branch,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitCheckoutErrorResponse(error);
			}
		},
		discardGitChanges: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let discardCwd = workspaceScope.workspacePath;
				if (taskScope) {
					discardCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
					});
				}
				const response = await discardGitChanges({
					cwd: discardCwd,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitDiscardErrorResponse(error);
			}
		},
		loadChanges: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			let taskCwd: string;
			try {
				taskCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: normalizedInput.taskId,
					baseRef: normalizedInput.baseRef,
					ensure: false,
				});
			} catch (error) {
				if (!isMissingTaskWorktreeError(error)) {
					throw error;
				}
				return await createEmptyWorkspaceChangesResponse(workspaceScope.workspacePath);
			}
			if (normalizedInput.mode === "last_turn") {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				let sessionSummary: import("../core/api-contract").RuntimeTaskSessionSummary | null = null;
				if (deps.getScopedPiTaskSessionService) {
					const piService = await deps.getScopedPiTaskSessionService(workspaceScope);
					sessionSummary = piService.getSummary(normalizedInput.taskId);
				}
				const summary = selectLastTurnSummary(terminalManager.getSummary(normalizedInput.taskId), sessionSummary);
				const fromCheckpoint = summary?.previousTurnCheckpoint;
				const toCheckpoint = summary?.latestTurnCheckpoint;
				if (!toCheckpoint) {
					return await createEmptyWorkspaceChangesResponse(taskCwd);
				}
				if (summary?.state === "running" || !fromCheckpoint) {
					return await getWorkspaceChangesFromRef({
						cwd: taskCwd,
						fromRef: toCheckpoint.commit,
					});
				}
				return await getWorkspaceChangesBetweenRefs({
					cwd: taskCwd,
					fromRef: fromCheckpoint.commit,
					toRef: toCheckpoint.commit,
				});
			}
			return await getWorkspaceChanges(taskCwd);
		},
		loadArtifacts: async (workspaceScope, input) => {
			const generatedAt = Date.now();
			let taskCwd: string;
			try {
				taskCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: input.taskId,
					baseRef: input.baseRef,
					ensure: false,
				});
			} catch (error) {
				if (!isMissingTaskWorktreeError(error)) {
					throw error;
				}
				// No worktree → no artifacts (weak references vanish with the worktree).
				return { artifacts: [], generatedAt };
			}
			let changedPaths: Awaited<ReturnType<typeof getWorkspaceChangedPathsFromRef>>;
			try {
				changedPaths = await getWorkspaceChangedPathsFromRef({ cwd: taskCwd, fromRef: input.baseRef });
			} catch {
				return { artifacts: [], generatedAt };
			}
			return {
				artifacts: detectArtifacts(changedPaths),
				generatedAt,
			} satisfies RuntimeArtifactsResponse;
		},
		loadArtifactContent: async (workspaceScope, input) => {
			const taskCwd = await resolveTaskCwd({
				cwd: workspaceScope.workspacePath,
				taskId: input.taskId,
				baseRef: input.baseRef,
				ensure: false,
			});
			return await readArtifactContent(taskCwd, input.path);
		},
		ensureWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeEnsureRequest(input);
			return await ensureTaskWorktreeIfDoesntExist({
				cwd: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: body.baseRef,
			});
		},
		deleteWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeDeleteRequest(input);
			return await deleteTaskWorktree({
				repoPath: workspaceScope.workspacePath,
				taskId: body.taskId,
			});
		},
		loadTaskContext: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			return await getTaskWorkspaceInfo({
				cwd: workspaceScope.workspacePath,
				taskId: normalizedInput.taskId,
				baseRef: normalizedInput.baseRef,
			});
		},
		searchFiles: async (workspaceScope, input) => {
			const query = input.query.trim();
			const limit = input.limit;
			const files = await searchWorkspaceFiles(workspaceScope.workspacePath, query, limit);
			return {
				query,
				files,
			} satisfies RuntimeWorkspaceFileSearchResponse;
		},
		loadState: async (workspaceScope) => {
			return await deps.buildWorkspaceStateSnapshot(workspaceScope.workspaceId, workspaceScope.workspacePath);
		},
		notifyStateUpdated: async (workspaceScope) => {
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
			return {
				ok: true,
			};
		},
		listFiles: async (workspaceScope) => {
			const files = await new FileLibraryStore(workspaceScope.workspacePath).list();
			return { files };
		},
		getFile: async (workspaceScope, input) => {
			const file = await new FileLibraryStore(workspaceScope.workspacePath).get(input.id);
			return { file };
		},
		addFile: async (workspaceScope, input) => {
			const file = await new FileLibraryStore(workspaceScope.workspacePath).add({
				name: input.name,
				bytes: Buffer.from(input.data, "base64"),
				mime: input.mime,
			});
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			return { file };
		},
		updateFile: async (workspaceScope, input) => {
			const file = await new FileLibraryStore(workspaceScope.workspacePath).rename(input.id, input.name);
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			return { file };
		},
		deleteFile: async (workspaceScope, input) => {
			const deleted = await new FileLibraryStore(workspaceScope.workspacePath).remove(input.id);
			if (deleted) {
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			}
			return { deleted };
		},
		getFileBytes: async (workspaceScope, input) => {
			const result = await new FileLibraryStore(workspaceScope.workspacePath).getBytes(input.id);
			if (!result) {
				return { file: null, data: null, mimeType: null };
			}
			return { file: result.item, data: result.data, mimeType: result.mimeType };
		},
		getFilePath: async (workspaceScope, input) => {
			const result = await new FileLibraryStore(workspaceScope.workspacePath).getPath(input.id);
			if (!result) {
				return { file: null, absolutePath: null, relativePath: null };
			}
			return { file: result.item, absolutePath: result.absolutePath, relativePath: result.relativePath };
		},
		listDocuments: async (workspaceScope, input) => {
			const type = input.type?.trim() ? input.type.trim() : undefined;
			const documents = await new VaultDocumentStore(workspaceScope.workspacePath).list(type);
			return { documents };
		},
		getDocument: async (workspaceScope, input) => {
			const document = await new VaultDocumentStore(workspaceScope.workspacePath).get(input.id);
			return { document };
		},
		getDocumentLinks: async (workspaceScope, input) => {
			const index = await new VaultDocumentStore(workspaceScope.workspacePath).getLinkIndex();
			return { outgoing: index.outgoing(input.id), backlinks: index.backlinks(input.id) };
		},
		searchDocuments: async (workspaceScope, input) => {
			const type = input.type?.trim() ? input.type.trim() : undefined;
			const results = await new VaultDocumentStore(workspaceScope.workspacePath).search(input.query, {
				type,
				limit: input.limit,
			});
			return { results };
		},
		createDocument: async (workspaceScope, input) => {
			const document = await new VaultDocumentStore(workspaceScope.workspacePath).create({
				type: input.type,
				title: input.title,
				body: input.body,
				frontmatter: input.frontmatter,
			});
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			return { document };
		},
		updateDocument: async (workspaceScope, input) => {
			const document = await new VaultDocumentStore(workspaceScope.workspacePath).update(input.id, {
				title: input.title,
				body: input.body,
				frontmatter: input.frontmatter,
			});
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			return { document };
		},
		deleteDocument: async (workspaceScope, input) => {
			const deleted = await new VaultDocumentStore(workspaceScope.workspacePath).remove(input.id);
			if (deleted) {
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			}
			return { deleted };
		},
		exportDocument: async (workspaceScope, input) => {
			const document = await new VaultDocumentStore(workspaceScope.workspacePath).exportDocument(input.id);
			return { document };
		},
		exportArchive: async (workspaceScope, input) => {
			const entries = await new VaultDocumentStore(workspaceScope.workspacePath).exportDocuments(input.ids);
			const data = await buildVaultZipBase64(entries);
			return { data, documentCount: entries.length };
		},
		listViews: async (workspaceScope, input) => {
			const type = input.type?.trim() ? input.type.trim() : undefined;
			const views = await new SavedViewStore(workspaceScope.workspacePath).list(type);
			return { views };
		},
		createView: async (workspaceScope, input) => {
			const view = await new SavedViewStore(workspaceScope.workspacePath).create(input);
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			return { view };
		},
		updateView: async (workspaceScope, input) => {
			const { id, ...patch } = input;
			const view = await new SavedViewStore(workspaceScope.workspacePath).update(id, patch);
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			return { view };
		},
		deleteView: async (workspaceScope, input) => {
			const deleted = await new SavedViewStore(workspaceScope.workspacePath).remove(input.id);
			if (deleted) {
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			}
			return { deleted };
		},
		getVaultSettings: async (workspaceScope) => {
			const settings = await new VaultSettingsStore(workspaceScope.workspacePath).get();
			return { settings };
		},
		getGitUserIdentity: async (workspaceScope) => {
			const identity = await readGitUserIdentity(workspaceScope.workspacePath);
			return { identity };
		},
		setGitUserIdentity: async (workspaceScope, input) => {
			await writeGitUserIdentity(workspaceScope.workspacePath, { name: input.name, email: input.email });
			const identity = await readGitUserIdentity(workspaceScope.workspacePath);
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			return { identity };
		},
		updateVaultSettings: async (workspaceScope, input) => {
			const settings = await new VaultSettingsStore(workspaceScope.workspacePath).set({
				vaultMode: input.vaultMode,
			});
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			return { settings };
		},
		getBoardSyncStatus: async (workspaceScope) => {
			const status = await deps.boardSync.getStatus(workspaceScope);
			return { status };
		},
		runBoardSyncAction: async (workspaceScope, input) => {
			return await deps.boardSync.runAction(workspaceScope, input.action);
		},
		setBoardAutoSync: async (workspaceScope, input) => {
			const status = await deps.boardSync.setAutoSyncPaused(workspaceScope, input.paused);
			return { status };
		},
		updateBoardBranch: async (workspaceScope, input) => {
			return await deps.boardSync.renameBranch(workspaceScope, input.branch);
		},
		saveState: async (workspaceScope, input) => {
			try {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				for (const summary of terminalManager.listSummaries()) {
					input.sessions[summary.taskId] = summary;
				}
				const response = await saveWorkspaceState(workspaceScope.workspacePath, input);
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
				void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
				return response;
			} catch (error) {
				if (error instanceof WorkspaceStateConflictError) {
					throw new TRPCError({
						code: "CONFLICT",
						message: error.message,
						cause: {
							currentRevision: error.currentRevision,
						},
					});
				}
				throw error;
			}
		},
		loadWorkspaceChanges: async (workspaceScope) => {
			return await getWorkspaceChanges(workspaceScope.workspacePath);
		},
		loadGitLog: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let logCwd = workspaceScope.workspacePath;
			if (taskScope) {
				logCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getGitLog({
				cwd: logCwd,
				ref: input.ref ?? null,
				refs: input.refs ?? null,
				maxCount: input.maxCount,
				skip: input.skip,
			});
		},
		loadGitRefs: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input ?? null);
			let refsCwd = workspaceScope.workspacePath;
			if (taskScope) {
				refsCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getGitRefs(refsCwd);
		},
		loadCommitDiff: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let diffCwd = workspaceScope.workspacePath;
			if (taskScope) {
				diffCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getCommitDiff({
				cwd: diffCwd,
				commitHash: input.commitHash,
			});
		},
	};
}
