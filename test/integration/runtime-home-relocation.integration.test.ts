import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import {
	getMachineKanbanHomePath,
	getRuntimeHomePath,
	getWorkspaceDirectoryPath,
	loadWorkspaceState,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const WORKSPACE_ID = "relocrepo";

function boardWithTask(title: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title,
						prompt: title,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
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

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

/** Returns true when git considers `relativePath` ignored inside `repoPath`. */
function isIgnoredByGit(repoPath: string, relativePath: string): boolean {
	const result = spawnSync("git", ["check-ignore", relativePath], {
		cwd: repoPath,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	return result.status === 0;
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-reloc-home-");
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

function seedLegacyBoard(title: string): void {
	const legacyDir = join(getMachineKanbanHomePath(), "workspaces", WORKSPACE_ID);
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(join(legacyDir, "board.json"), JSON.stringify(boardWithTask(title)), "utf8");
}

describe.sequential("runtime home relocation", () => {
	it("roots workspace data under <repoPath>/.kanban while the index stays in ~/.kanban", async () => {
		await withTemporaryHome(async () => {
			const { path: sandbox, cleanup } = createTempDir("kanban-reloc-");
			try {
				const repoPath = join(sandbox, WORKSPACE_ID);
				mkdirSync(repoPath, { recursive: true });
				initGitRepository(repoPath);

				const initial = await loadWorkspaceState(repoPath);
				await saveWorkspaceState(repoPath, {
					board: boardWithTask("Repo Rooted Task"),
					sessions: {},
					expectedRevision: initial.revision,
				});

				// Workspace content is written under the repo, not the machine home.
				expect(existsSync(join(getWorkspaceDirectoryPath(repoPath, WORKSPACE_ID), "board.json"))).toBe(true);
				expect(existsSync(join(getMachineKanbanHomePath(), "workspaces", WORKSPACE_ID, "board.json"))).toBe(false);
				// The cross-repo index registry stays machine-rooted.
				expect(existsSync(join(getMachineKanbanHomePath(), "workspaces", "index.json"))).toBe(true);
			} finally {
				cleanup();
			}
		});
	});

	it("copy-migrates legacy ~/.kanban data into the repo and leaves the original intact", async () => {
		await withTemporaryHome(async () => {
			const { path: sandbox, cleanup } = createTempDir("kanban-reloc-");
			try {
				const repoPath = join(sandbox, WORKSPACE_ID);
				mkdirSync(repoPath, { recursive: true });
				initGitRepository(repoPath);
				seedLegacyBoard("Migrated Task");

				const state = await loadWorkspaceState(repoPath);

				// Migrated content is served from the repo location...
				expect(state.board.columns[0]?.cards[0]?.title).toBe("Migrated Task");
				const repoBoardPath = join(getWorkspaceDirectoryPath(repoPath, WORKSPACE_ID), "board.json");
				expect(existsSync(repoBoardPath)).toBe(true);
				// ...and the legacy original is never moved or deleted.
				const legacyBoardPath = join(getMachineKanbanHomePath(), "workspaces", WORKSPACE_ID, "board.json");
				expect(existsSync(legacyBoardPath)).toBe(true);
			} finally {
				cleanup();
			}
		});
	});

	it("falls back to legacy data when the repo location predates a given file", async () => {
		await withTemporaryHome(async () => {
			const { path: sandbox, cleanup } = createTempDir("kanban-reloc-");
			try {
				const repoPath = join(sandbox, WORKSPACE_ID);
				mkdirSync(repoPath, { recursive: true });
				initGitRepository(repoPath);
				// Repo workspace dir already exists (so migration skips the copy)...
				mkdirSync(getWorkspaceDirectoryPath(repoPath, WORKSPACE_ID), { recursive: true });
				// ...but only the legacy location holds the board.
				seedLegacyBoard("Legacy Fallback Task");

				const state = await loadWorkspaceState(repoPath);

				expect(state.board.columns[0]?.cards[0]?.title).toBe("Legacy Fallback Task");
			} finally {
				cleanup();
			}
		});
	});

	it("writes a .gitignore that commits content but ignores runtime + secrets", async () => {
		await withTemporaryHome(async () => {
			const { path: sandbox, cleanup } = createTempDir("kanban-reloc-");
			try {
				const repoPath = join(sandbox, WORKSPACE_ID);
				mkdirSync(repoPath, { recursive: true });
				initGitRepository(repoPath);

				await loadWorkspaceState(repoPath);

				expect(existsSync(join(getRuntimeHomePath(repoPath), ".gitignore"))).toBe(true);
				// Runtime + secrets are ignored.
				expect(isIgnoredByGit(repoPath, ".kanban/worktrees/abc/proj")).toBe(true);
				expect(isIgnoredByGit(repoPath, `.kanban/workspaces/${WORKSPACE_ID}/sessions.json`)).toBe(true);
				expect(isIgnoredByGit(repoPath, `.kanban/workspaces/${WORKSPACE_ID}/meta.json`)).toBe(true);
				expect(isIgnoredByGit(repoPath, ".kanban/settings/provider_settings.json")).toBe(true);
				expect(isIgnoredByGit(repoPath, ".kanban/state.lock")).toBe(true);
				// Content is committed (NOT ignored).
				expect(isIgnoredByGit(repoPath, `.kanban/workspaces/${WORKSPACE_ID}/board.json`)).toBe(false);
				expect(isIgnoredByGit(repoPath, `.kanban/workspaces/${WORKSPACE_ID}/requirements.json`)).toBe(false);
			} finally {
				cleanup();
			}
		});
	});
});
