import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import {
	getWorkspaceBoardReadCountForTests,
	invalidateWorkspaceBoardCache,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	resetWorkspaceBoardCacheForTests,
	resetWorkspaceIndexCacheForTests,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function initRepository(path: string): void {
	const env = createGitTestEnv();
	for (const args of [
		["init", "-q", "-b", "main"],
		["config", "user.name", "Test User"],
		["config", "user.email", "test@example.com"],
	]) {
		const result = spawnSync("git", args, { cwd: path, encoding: "utf8", env });
		if (result.status !== 0) {
			throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
		}
	}
	writeFileSync(join(path, "file.txt"), "hello\n", "utf8");
	spawnSync("git", ["add", "."], { cwd: path, encoding: "utf8", env });
	spawnSync("git", ["commit", "-qm", "init"], { cwd: path, encoding: "utf8", env });
}

function boardWith(title: string): RuntimeBoardData {
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

async function withTemporaryHome<T>(run: (repoPath: string, workspaceId: string) => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-board-cache-home-");
	const { path: repoPath, cleanup: cleanupRepo } = createTempDir("kanban-board-cache-repo-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	resetWorkspaceIndexCacheForTests();
	resetWorkspaceBoardCacheForTests();
	try {
		initRepository(repoPath);
		const context = await loadWorkspaceContext(repoPath);
		resetWorkspaceBoardCacheForTests();
		return await run(context.repoPath, context.workspaceId);
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
		resetWorkspaceIndexCacheForTests();
		resetWorkspaceBoardCacheForTests();
		cleanupRepo();
		cleanupHome();
	}
}

describe("workspace board revision-keyed memo", () => {
	it("reads the board shards once across repeated loads at the same revision (#5)", async () => {
		await withTemporaryHome(async (repoPath) => {
			const before = getWorkspaceBoardReadCountForTests();
			await loadWorkspaceState(repoPath);
			await loadWorkspaceState(repoPath);
			await loadWorkspaceState(repoPath);
			expect(getWorkspaceBoardReadCountForTests() - before).toBe(1);
		});
	});

	it("shares one board read between loadWorkspaceState and loadWorkspaceBoardById (#4)", async () => {
		await withTemporaryHome(async (repoPath, workspaceId) => {
			const before = getWorkspaceBoardReadCountForTests();
			await loadWorkspaceState(repoPath);
			await loadWorkspaceBoardById(workspaceId);
			expect(getWorkspaceBoardReadCountForTests() - before).toBe(1);
		});
	});

	it("dedups two concurrent board reads into a single shard read (#4 in-flight)", async () => {
		await withTemporaryHome(async (repoPath, workspaceId) => {
			const before = getWorkspaceBoardReadCountForTests();
			await Promise.all([loadWorkspaceState(repoPath), loadWorkspaceBoardById(workspaceId)]);
			expect(getWorkspaceBoardReadCountForTests() - before).toBe(1);
		});
	});

	it("re-reads after a save bumps the revision", async () => {
		await withTemporaryHome(async (repoPath) => {
			const initial = await loadWorkspaceState(repoPath);
			await saveWorkspaceState(repoPath, {
				board: boardWith("renamed"),
				sessions: initial.sessions,
				expectedRevision: initial.revision,
			});
			const before = getWorkspaceBoardReadCountForTests();
			const reloaded = await loadWorkspaceState(repoPath);
			expect(getWorkspaceBoardReadCountForTests() - before).toBe(1);
			expect(reloaded.board.columns[0]?.cards[0]?.title).toBe("renamed");
		});
	});

	it("re-reads after invalidateWorkspaceBoardCache (board-sync pull path)", async () => {
		await withTemporaryHome(async (repoPath, workspaceId) => {
			await loadWorkspaceState(repoPath); // warm
			const before = getWorkspaceBoardReadCountForTests();
			invalidateWorkspaceBoardCache(repoPath, workspaceId);
			await loadWorkspaceState(repoPath);
			expect(getWorkspaceBoardReadCountForTests() - before).toBe(1);
		});
	});
});
