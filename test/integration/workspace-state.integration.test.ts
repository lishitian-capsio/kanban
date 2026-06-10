import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeRequirementItem, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { confirmLink, proposeLink } from "../../src/core/requirement-task-link-mutations";
import { appendRequirementVersion } from "../../src/core/requirement-versions";
import type { WorkspaceStateConflictError } from "../../src/state/workspace-state";
import {
	getWorkspacesRootPath,
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
	loadWorkspaceContextById,
	loadWorkspaceRequirementTaskLinks,
	loadWorkspaceRequirementVersions,
	loadWorkspaceState,
	mutateWorkspaceState,
	removeWorkspaceIndexEntry,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function createBoard(title: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title: title,
						prompt: title,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createSessionSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

describe.sequential("workspace-state integration", () => {
	it("persists revision numbers and rejects stale writes", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-");
			try {
				const workspacePath = join(sandboxRoot, "project-a");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const initial = await loadWorkspaceState(workspacePath);
				expect(initial.revision).toBe(0);

				const firstSave = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					expectedRevision: initial.revision,
				});
				expect(firstSave.revision).toBe(1);
				expect(firstSave.board.columns[0]?.cards[0]?.prompt).toBe("Task One");

				const secondSave = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task Two"),
					sessions: {},
					expectedRevision: firstSave.revision,
				});
				expect(secondSave.revision).toBe(2);
				expect(secondSave.board.columns[0]?.cards[0]?.prompt).toBe("Task Two");

				await expect(
					saveWorkspaceState(workspacePath, {
						board: createBoard("Stale Task"),
						sessions: {},
						expectedRevision: firstSave.revision,
					}),
				).rejects.toMatchObject({
					name: "WorkspaceStateConflictError",
					currentRevision: secondSave.revision,
				} satisfies Partial<WorkspaceStateConflictError>);

				const loadedAfterConflict = await loadWorkspaceState(workspacePath);
				expect(loadedAfterConflict.revision).toBe(2);
				expect(loadedAfterConflict.board.columns[0]?.cards[0]?.prompt).toBe("Task Two");
			} finally {
				cleanup();
			}
		});
	});

	it("round-trips requirements and defaults to empty for old workspaces", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-requirements-");
			try {
				const workspacePath = join(sandboxRoot, "project-req");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				// Old workspace (no requirements.json yet) falls back to an empty list.
				const initial = await loadWorkspaceState(workspacePath);
				expect(initial.requirements).toEqual({ items: [] });

				const saved = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					requirements: {
						items: [
							{
								id: "req-1",
								title: "Phone login",
								description: "Support phone-number login",
								priority: "high",
								status: "active",
								linkedTaskIds: [],
								order: 0,
								createdAt: Date.now(),
								updatedAt: Date.now(),
							},
						],
					},
					expectedRevision: initial.revision,
				});
				expect(saved.requirements.items).toHaveLength(1);
				expect(saved.requirements.items[0]?.title).toBe("Phone login");

				const reloaded = await loadWorkspaceState(workspacePath);
				expect(reloaded.requirements.items[0]?.priority).toBe("high");
				expect(reloaded.requirements.items[0]?.status).toBe("active");
			} finally {
				cleanup();
			}
		});
	});

	it("preserves existing requirements when a save payload omits them", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-requirements-preserve-");
			try {
				const workspacePath = join(sandboxRoot, "project-preserve");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const initial = await loadWorkspaceState(workspacePath);
				const withRequirements = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					requirements: {
						items: [
							{
								id: "req-1",
								title: "Keep me",
								description: "",
								priority: "medium",
								status: "draft",
								linkedTaskIds: [],
								order: 0,
								createdAt: Date.now(),
								updatedAt: Date.now(),
							},
						],
					},
					expectedRevision: initial.revision,
				});
				expect(withRequirements.requirements.items).toHaveLength(1);

				// A legacy board-only save (no requirements field) must NOT wipe requirements.
				const boardOnlySave = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task Two"),
					sessions: {},
					expectedRevision: withRequirements.revision,
				});
				expect(boardOnlySave.requirements.items).toHaveLength(1);
				expect(boardOnlySave.requirements.items[0]?.title).toBe("Keep me");

				const reloaded = await loadWorkspaceState(workspacePath);
				expect(reloaded.requirements.items).toHaveLength(1);
			} finally {
				cleanup();
			}
		});
	});

	it("records and preserves requirement versions independently of board saves", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-req-versions-");
			try {
				const workspacePath = join(sandboxRoot, "project-versions");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				// Old workspace: no versions file yet → empty.
				expect(await loadWorkspaceRequirementVersions(workspacePath)).toEqual({ versions: [] });

				const snapshot: RuntimeRequirementItem = {
					id: "req-1",
					title: "Phone login",
					description: "",
					priority: "high",
					status: "active",
					linkedTaskIds: [],
					order: 0,
					createdAt: 1000,
					updatedAt: 1000,
				};

				await mutateWorkspaceState(workspacePath, (state, { requirementVersions }) => {
					const appended = appendRequirementVersion(requirementVersions, {
						requirementId: "req-1",
						snapshot,
						changeKind: "create",
						source: "human",
						now: 1000,
					});
					return {
						board: state.board,
						requirements: { items: [snapshot] },
						requirementVersions: appended.data,
						value: null,
					};
				});

				const stored = await loadWorkspaceRequirementVersions(workspacePath);
				expect(stored.versions).toHaveLength(1);
				expect(stored.versions[0]).toMatchObject({
					requirementId: "req-1",
					version: 1,
					changeKind: "create",
					source: "human",
				});

				// A board-only saveWorkspaceState must NOT wipe the versions file.
				const current = await loadWorkspaceState(workspacePath);
				await saveWorkspaceState(workspacePath, {
					board: createBoard("Task Two"),
					sessions: {},
					expectedRevision: current.revision,
				});
				const afterSave = await loadWorkspaceRequirementVersions(workspacePath);
				expect(afterSave.versions).toHaveLength(1);
			} finally {
				cleanup();
			}
		});
	});

	it("round-trips requirement task links and defaults to empty for old workspaces", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-req-links-");
			try {
				const workspacePath = join(sandboxRoot, "project-links");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				// Old workspace: no requirement-task-links.json yet → empty list.
				const initial = await loadWorkspaceState(workspacePath);
				expect(initial.requirementTaskLinks).toEqual({ links: [] });
				expect(await loadWorkspaceRequirementTaskLinks(workspacePath)).toEqual({ links: [] });

				const requirement: RuntimeRequirementItem = {
					id: "req-1",
					title: "Phone login",
					description: "",
					priority: "high",
					status: "active",
					linkedTaskIds: [],
					order: 0,
					createdAt: 1000,
					updatedAt: 1000,
				};

				// An agent proposes a link, then a human confirms it — all through the atomic pipeline.
				await mutateWorkspaceState(workspacePath, (state, { requirementTaskLinks, requirementVersions }) => {
					const proposed = proposeLink(
						{ items: [requirement] },
						requirementTaskLinks,
						requirementVersions,
						"req-1",
						"task-1",
						{ source: "agent", now: 2000 },
					);
					return {
						board: state.board,
						requirements: proposed.requirements,
						requirementTaskLinks: proposed.links,
						requirementVersions: proposed.versions,
						value: null,
					};
				});

				const afterPropose = await loadWorkspaceState(workspacePath);
				expect(afterPropose.requirementTaskLinks.links).toEqual([
					{ requirementId: "req-1", taskId: "task-1", status: "proposed", source: "agent", createdAt: 2000 },
				]);
				// Proposed links are not yet confirmed associations.
				expect(afterPropose.requirements.items[0]?.linkedTaskIds).toEqual([]);

				await mutateWorkspaceState(workspacePath, (state, { requirementTaskLinks, requirementVersions }) => {
					const confirmed = confirmLink(
						state.requirements,
						requirementTaskLinks,
						requirementVersions,
						"req-1",
						"task-1",
						{ source: "human", now: 3000 },
					);
					return {
						board: state.board,
						requirements: confirmed.requirements,
						requirementTaskLinks: confirmed.links,
						requirementVersions: confirmed.versions,
						value: null,
					};
				});

				const afterConfirm = await loadWorkspaceState(workspacePath);
				expect(afterConfirm.requirementTaskLinks.links[0]?.status).toBe("confirmed");
				// Confirmed associations are mirrored into the requirement's linkedTaskIds.
				expect(afterConfirm.requirements.items[0]?.linkedTaskIds).toEqual(["task-1"]);

				const versions = await loadWorkspaceRequirementVersions(workspacePath);
				expect(versions.versions.map((v) => v.source)).toEqual(["agent", "human"]);
			} finally {
				cleanup();
			}
		});
	});

	it("preserves existing requirement task links when a save payload omits them", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-req-links-preserve-");
			try {
				const workspacePath = join(sandboxRoot, "project-links-preserve");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const initial = await loadWorkspaceState(workspacePath);
				const withLinks = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					requirementTaskLinks: {
						links: [
							{
								requirementId: "req-1",
								taskId: "task-1",
								status: "proposed",
								source: "agent",
								createdAt: 2000,
							},
						],
					},
					expectedRevision: initial.revision,
				});
				expect(withLinks.requirementTaskLinks.links).toHaveLength(1);

				// A legacy board-only save (no requirementTaskLinks field) must NOT wipe the links.
				const boardOnlySave = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task Two"),
					sessions: {},
					expectedRevision: withLinks.revision,
				});
				expect(boardOnlySave.requirementTaskLinks.links).toHaveLength(1);
				expect(boardOnlySave.requirementTaskLinks.links[0]?.taskId).toBe("task-1");
			} finally {
				cleanup();
			}
		});
	});

	it("versions requirement create/update/delete made through saveWorkspaceState", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-save-versions-");
			try {
				const workspacePath = join(sandboxRoot, "project-save-versions");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const makeReq = (overrides: Partial<RuntimeRequirementItem>): RuntimeRequirementItem => ({
					id: "req-1",
					title: "Phone login",
					description: "",
					priority: "medium",
					status: "draft",
					linkedTaskIds: [],
					order: 0,
					createdAt: 1000,
					updatedAt: 1000,
					...overrides,
				});

				const initial = await loadWorkspaceState(workspacePath);

				// Create through the web-UI save path → v1.
				const created = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					requirements: { items: [makeReq({})] },
					expectedRevision: initial.revision,
				});
				let versions = await loadWorkspaceRequirementVersions(workspacePath);
				expect(versions.versions.map((v) => ({ version: v.version, kind: v.changeKind, source: v.source }))).toEqual([
					{ version: 1, kind: "create", source: "human" },
				]);

				// Edit a versioned field → v2.
				const edited = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					requirements: { items: [makeReq({ title: "Phone + email login", status: "active" })] },
					expectedRevision: created.revision,
				});
				versions = await loadWorkspaceRequirementVersions(workspacePath);
				expect(versions.versions.map((v) => v.version)).toEqual([1, 2]);
				expect(versions.versions[1]).toMatchObject({ version: 2, changeKind: "update", source: "human" });
				expect(versions.versions[1]?.snapshot.title).toBe("Phone + email login");

				// Reordering only (no versioned field) must NOT create a version.
				const reordered = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					requirements: { items: [makeReq({ title: "Phone + email login", status: "active", order: 5 })] },
					expectedRevision: edited.revision,
				});
				versions = await loadWorkspaceRequirementVersions(workspacePath);
				expect(versions.versions.map((v) => v.version)).toEqual([1, 2]);

				// Delete (item removed from the snapshot) → v3.
				await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					requirements: { items: [] },
					expectedRevision: reordered.revision,
				});
				versions = await loadWorkspaceRequirementVersions(workspacePath);
				expect(versions.versions.map((v) => v.version)).toEqual([1, 2, 3]);
				expect(versions.versions[2]).toMatchObject({ version: 3, changeKind: "delete", source: "human" });
			} finally {
				cleanup();
			}
		});
	});

	it("lists and removes workspace index entries across multiple projects", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspaces-");
			try {
				const workspaceAPath = join(sandboxRoot, "alpha");
				const workspaceBPath = join(sandboxRoot, "beta");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);

				const contextA = await loadWorkspaceContext(workspaceAPath);
				const contextB = await loadWorkspaceContext(workspaceBPath);

				const entries = await listWorkspaceIndexEntries();
				expect(entries).toHaveLength(2);
				expect(entries.map((entry) => entry.workspaceId).sort()).toEqual(
					[contextA.workspaceId, contextB.workspaceId].sort(),
				);

				expect(await loadWorkspaceContextById(contextA.workspaceId)).not.toBeNull();
				expect(await removeWorkspaceIndexEntry(contextA.workspaceId)).toBe(true);
				expect(await loadWorkspaceContextById(contextA.workspaceId)).toBeNull();
				expect(await removeWorkspaceIndexEntry(contextA.workspaceId)).toBe(false);

				const entriesAfterRemoval = await listWorkspaceIndexEntries();
				expect(entriesAfterRemoval).toHaveLength(1);
				expect(entriesAfterRemoval[0]?.workspaceId).toBe(contextB.workspaceId);
			} finally {
				cleanup();
			}
		});
	});

	it("keeps all workspace index entries when projects are added concurrently", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspaces-concurrent-");
			try {
				const workspaceAPath = join(sandboxRoot, "alpha");
				const workspaceBPath = join(sandboxRoot, "beta");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);

				const [contextA, contextB] = await Promise.all([
					loadWorkspaceContext(workspaceAPath),
					loadWorkspaceContext(workspaceBPath),
				]);

				const entries = await listWorkspaceIndexEntries();
				expect(entries).toHaveLength(2);
				expect(entries.map((entry) => entry.workspaceId).sort()).toEqual(
					[contextA.workspaceId, contextB.workspaceId].sort(),
				);
			} finally {
				cleanup();
			}
		});
	});

	it("creates readable workspace ids from folder names with random suffix on collisions", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-id-format-");
			try {
				const workspaceAPath = join(sandboxRoot, "one", "vscrui");
				const workspaceBPath = join(sandboxRoot, "two", "vscrui");
				const workspaceCPath = join(sandboxRoot, "three", "My Cool Repo");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				mkdirSync(workspaceCPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);
				initGitRepository(workspaceCPath);

				const contextA = await loadWorkspaceContext(workspaceAPath);
				const contextB = await loadWorkspaceContext(workspaceBPath);
				const contextC = await loadWorkspaceContext(workspaceCPath);

				expect(contextA.workspaceId).toBe("vscrui");
				expect(contextB.workspaceId).toMatch(/^vscrui-[a-z0-9]{4}$/);
				expect(contextB.workspaceId).not.toBe(contextA.workspaceId);
				expect(contextC.workspaceId).toBe("my-cool-repo");

				const contextAAgain = await loadWorkspaceContext(workspaceAPath);
				expect(contextAAgain.workspaceId).toBe(contextA.workspaceId);
			} finally {
				cleanup();
			}
		});
	});

	it("can require an existing project without auto-creating workspace entries", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-autocreate-");
			try {
				const workspacePath = join(sandboxRoot, "gamma");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				await expect(
					loadWorkspaceContext(workspacePath, {
						autoCreateIfMissing: false,
					}),
				).rejects.toThrow("is not added to Kanban yet");

				const created = await loadWorkspaceContext(workspacePath);
				expect(created.repoPath).toBeTruthy();

				const existing = await loadWorkspaceContext(workspacePath, {
					autoCreateIfMissing: false,
				});
				expect(existing.workspaceId).toBe(created.workspaceId);
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted board data is malformed", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-malformed-board-");
			try {
				const workspacePath = join(sandboxRoot, "project-bad-board");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const context = await loadWorkspaceContext(workspacePath);
				mkdirSync(context.statePath, { recursive: true });
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify(
						{
							columns: [
								{
									id: "backlog",
									title: "Backlog",
									cards: [
										{
											prompt: "Missing ID and baseRef",
											startInPlanMode: false,
											createdAt: Date.now(),
											updatedAt: Date.now(),
										},
									],
								},
								{ id: "in_progress", title: "In Progress", cards: [] },
								{ id: "review", title: "Review", cards: [] },
								{ id: "trash", title: "Done", cards: [] },
							],
						},
						null,
						2,
					),
					"utf8",
				);

				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("board.json");
				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow(/id|baseRef/);
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted sessions include unknown states", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-malformed-sessions-");
			try {
				const workspacePath = join(sandboxRoot, "project-bad-sessions");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const context = await loadWorkspaceContext(workspacePath);
				mkdirSync(context.statePath, { recursive: true });
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify(createBoard("Valid board"), null, 2),
					"utf8",
				);
				writeFileSync(
					join(context.statePath, "sessions.json"),
					JSON.stringify(
						{
							"task-1": {
								...createSessionSummary("task-1"),
								state: "not-a-valid-state",
							},
						},
						null,
						2,
					),
					"utf8",
				);

				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("sessions.json");
				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("state");
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted workspace index data is malformed", async () => {
		await withTemporaryHome(async () => {
			mkdirSync(getWorkspacesRootPath(), { recursive: true });
			writeFileSync(
				join(getWorkspacesRootPath(), "index.json"),
				JSON.stringify(
					{
						version: 1,
						entries: {
							"workspace-a": {
								workspaceId: "workspace-a",
							},
						},
						repoPathToId: {},
					},
					null,
					2,
				),
				"utf8",
			);

			await expect(listWorkspaceIndexEntries()).rejects.toThrow("index.json");
			await expect(listWorkspaceIndexEntries()).rejects.toThrow("repoPath");
		});
	});
});
