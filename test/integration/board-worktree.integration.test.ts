import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { writeBoardRef } from "../../src/state/board-ref";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { getBoardWorktreeDataHome, getBoardWorktreePath } from "../../src/workspace/board-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, stdio: "ignore", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
	}
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-board-wt-home-");
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

function singleTaskBoard(): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "tsk01",
						title: "First task",
						prompt: "Do the thing",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

describe.sequential("board worktree routing (board-ref active)", () => {
	it("routes committed board data into the board worktree, not the main checkout", async () => {
		const { path: parent, cleanup } = createTempDir("kanban-board-wt-repo-");
		const repoPath = join(parent, "acme");

		try {
			await withTemporaryHome(async () => {
				spawnSync("mkdir", ["-p", repoPath]);
				git(repoPath, ["init", "-q", "-b", "main", "."]);
				git(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"]);

				// Activate board-branch decoupling for this repo.
				await writeBoardRef(repoPath, { version: 1, branch: "kanban/board" });

				// Loading the context ensures the board worktree and repoints boardDataHome.
				const context = await loadWorkspaceContext(repoPath);
				expect(context.boardData.boardDataHome).toBe(getBoardWorktreeDataHome(repoPath));
				expect(existsSync(getBoardWorktreePath(repoPath))).toBe(true);

				const workspaceId = context.workspaceId;

				const initial = await loadWorkspaceState(repoPath);
				await saveWorkspaceState(repoPath, {
					board: singleTaskBoard(),
					sessions: {},
					expectedRevision: initial.revision,
				});

				// The task shard lives inside the board worktree's .kanban...
				const taskShardInWorktree = join(
					getBoardWorktreeDataHome(repoPath),
					"workspaces",
					workspaceId,
					"tasks",
					"tsk01.json",
				);
				expect(existsSync(taskShardInWorktree)).toBe(true);

				// ...and NOT in the main checkout's .kanban (which only holds runtime state).
				const taskShardInMainCheckout = join(repoPath, ".kanban", "workspaces", workspaceId, "tasks", "tsk01.json");
				expect(existsSync(taskShardInMainCheckout)).toBe(false);

				// And the board round-trips through the worktree.
				const reloaded = await loadWorkspaceState(repoPath);
				const backlog = reloaded.board.columns.find((column) => column.id === "backlog");
				expect(backlog?.cards.map((card) => card.id)).toEqual(["tsk01"]);
			});
		} finally {
			cleanup();
		}
	});
});
