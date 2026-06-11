import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, stdio: "ignore", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
	}
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-shard-home-");
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

function boardWithGraph(): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "blk01",
						title: "Blocked task",
						prompt: "Depends on the review task",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{
				id: "in_progress",
				title: "In Progress",
				cards: [
					{
						id: "wip01",
						title: "Work in progress",
						prompt: "Currently being worked on",
						startInPlanMode: true,
						baseRef: "main",
						createdAt: 2,
						updatedAt: 2,
					},
				],
			},
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "rev01",
						title: "Awaiting review",
						prompt: "Blocks the backlog task",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 3,
						updatedAt: 3,
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [{ id: "dep01", fromTaskId: "blk01", toTaskId: "rev01", createdAt: 4 }],
	};
}

describe.sequential("sharded task persistence (fresh clone)", () => {
	it("a fresh clone with no local state shows every task, its column, and its dependencies", async () => {
		const { path: originParent, cleanup: cleanupOrigin } = createTempDir("kanban-shard-origin-");
		const { path: cloneParent, cleanup: cleanupClone } = createTempDir("kanban-shard-clone-");
		const originRepo = join(originParent, "acme");
		const clonedRepo = join(cloneParent, "acme");

		try {
			// 1. Author the board in the origin repo, then commit the durable content.
			await withTemporaryHome(async () => {
				mkdirSync(originRepo, { recursive: true });
				git(originRepo, ["init"]);
				const initial = await loadWorkspaceState(originRepo);
				await saveWorkspaceState(originRepo, {
					board: boardWithGraph(),
					sessions: {},
					expectedRevision: initial.revision,
				});
				// Stage everything git allows — the .kanban/.gitignore keeps runtime out.
				git(originRepo, ["add", "-A"]);
				git(originRepo, ["commit", "-m", "tasks"]);
			});

			// 2. A teammate on a clean machine (empty ~/.kanban) clones the repo.
			await withTemporaryHome(async () => {
				git(cloneParent, ["clone", originRepo, clonedRepo]);

				// Sanity: the clone has only the committed sharded content, no runtime.
				expect(existsSync(join(clonedRepo, ".kanban", "workspaces", "acme", "tasks", "blk01.json"))).toBe(true);
				expect(existsSync(join(clonedRepo, ".kanban", "workspaces", "acme", "sessions.json"))).toBe(false);
				expect(existsSync(join(clonedRepo, ".kanban", "workspaces", "acme", "meta.json"))).toBe(false);

				const state = await loadWorkspaceState(clonedRepo);

				const byColumn = Object.fromEntries(
					state.board.columns.map((column) => [column.id, column.cards.map((card) => card.id)]),
				);
				expect(byColumn).toEqual({
					backlog: ["blk01"],
					in_progress: ["wip01"],
					review: ["rev01"],
					trash: [],
				});
				expect(state.board.dependencies).toEqual([
					{ id: "dep01", fromTaskId: "blk01", toTaskId: "rev01", createdAt: 4 },
				]);
			});
		} finally {
			cleanupClone();
			cleanupOrigin();
		}
	});
});
