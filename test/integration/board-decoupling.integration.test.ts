import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { getBoardRefPath, isBoardDecouplingActive, readBoardRef } from "../../src/state/board-ref";
import {
	isRepoRuntimeHomePreparedForTests,
	loadWorkspaceContext,
	loadWorkspaceState,
	resetRepoRuntimeHomePreparedCacheForTests,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { getBoardWorktreeDataHome, getBoardWorktreePath } from "../../src/workspace/board-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function gitStatus(cwd: string): string {
	return spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", env: createGitTestEnv() }).stdout.trim();
}

function writeFileEnsuringDir(filePath: string, contents: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents, "utf8");
}

async function withTemporaryHomeAt(tempHome: string, run: () => Promise<void>): Promise<void> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		await run();
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
	}
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-decouple-home-");
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

function singleTaskBoard(taskId: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: taskId,
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

// Each test runs under its own temp HOME so the machine-rooted workspace index does
// not leak across cases; sequential because they share that mutable process env.
describe.sequential("board-branch decoupling migration (P2)", () => {
	it("state ①: existing repo with committed .kanban data → moved to board branch, untracked on code", async () => {
		const { path: parent, cleanup } = createTempDir("kanban-decouple-existing-");
		const repoPath = join(parent, "acme");
		try {
			await withTemporaryHome(async () => {
				spawnSync("mkdir", ["-p", repoPath]);
				git(repoPath, ["init", "-q", "-b", "main", "."]);
				git(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"]);

				// Construct the pre-decouple world: committed board data tracked on the
				// code branch (a repo upgraded from before the board-branch feature). The
				// migration is eager, so this state must exist on disk *before* the first
				// load — we can't create it via loadWorkspaceContext (which decouples).
				writeFileEnsuringDir(
					join(repoPath, ".kanban", "workspaces", "oldws", "tasks", "old1.json"),
					'{"id":"old1"}',
				);
				git(repoPath, ["add", "-A"]);
				git(repoPath, ["commit", "-q", "-m", "kanban: legacy board data"]);
				expect(git(repoPath, ["ls-files", ".kanban/workspaces"])).not.toBe("");

				// First load triggers the decouple migration.
				const context = await loadWorkspaceContext(repoPath);
				expect(isBoardDecouplingActive(repoPath)).toBe(true);
				expect(context.boardData.boardDataHome).toBe(getBoardWorktreeDataHome(repoPath));

				// The pointer is committed; the legacy data moved onto the board branch.
				expect(git(repoPath, ["ls-files", ".kanban/board-ref"])).toBe(".kanban/board-ref");
				expect((await readBoardRef(repoPath))?.branch).toBe("kanban/board");
				expect(
					existsSync(join(getBoardWorktreeDataHome(repoPath), "workspaces", "oldws", "tasks", "old1.json")),
				).toBe(true);
				expect(git(getBoardWorktreePath(repoPath), ["ls-files", ".kanban/workspaces/oldws/tasks/old1.json"])).toBe(
					".kanban/workspaces/oldws/tasks/old1.json",
				);

				// The code branch no longer tracks .kanban data — only the pointer.
				expect(git(repoPath, ["ls-files", ".kanban/workspaces"])).toBe("");
				expect(git(repoPath, ["ls-files", ".kanban"])).toBe(".kanban/board-ref");
				const rootGitignore = readFileSync(join(repoPath, ".gitignore"), "utf8");
				expect(rootGitignore).toContain("/.kanban/*");
				expect(rootGitignore).toContain("!/.kanban/board-ref");

				// The code tree is clean (the whole point) and the board round-trips.
				expect(gitStatus(repoPath)).toBe("");
				const reloaded = await loadWorkspaceState(repoPath);
				expect(reloaded.board.columns.length).toBeGreaterThan(0);

				// End-to-end (the 9d884 scenario): the runtime keeps writing board state,
				// yet the *code* tree stays clean — so switching code branches is never
				// blocked by "local changes would be overwritten", no pre-commit patch needed.
				await saveWorkspaceState(repoPath, {
					board: singleTaskBoard("tsk-after-decouple"),
					sessions: {},
					expectedRevision: reloaded.revision,
				});
				expect(gitStatus(repoPath)).toBe("");
				git(repoPath, ["switch", "-q", "-c", "feature/probe"]);
				expect(gitStatus(repoPath)).toBe("");
				expect(git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/probe");
			});
		} finally {
			cleanup();
		}
	});

	it("state ②: brand-new repo → empty board branch initialized on first load", async () => {
		const { path: parent, cleanup } = createTempDir("kanban-decouple-new-");
		const repoPath = join(parent, "fresh");
		try {
			await withTemporaryHome(async () => {
				spawnSync("mkdir", ["-p", repoPath]);
				git(repoPath, ["init", "-q", "-b", "main", "."]);
				git(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"]);

				const context = await loadWorkspaceContext(repoPath);
				expect(isBoardDecouplingActive(repoPath)).toBe(true);
				expect(context.boardData.boardDataHome).toBe(getBoardWorktreeDataHome(repoPath));
				expect(existsSync(getBoardWorktreePath(repoPath))).toBe(true);
				expect(git(repoPath, ["ls-files", ".kanban/board-ref"])).toBe(".kanban/board-ref");

				// Writing a board lands it in the worktree, not the code tree.
				const initial = await loadWorkspaceState(repoPath);
				await saveWorkspaceState(repoPath, {
					board: singleTaskBoard("tsk99"),
					sessions: {},
					expectedRevision: initial.revision,
				});
				const wsId = context.workspaceId;
				expect(
					existsSync(join(getBoardWorktreeDataHome(repoPath), "workspaces", wsId, "tasks", "tsk99.json")),
				).toBe(true);
				expect(existsSync(join(repoPath, ".kanban", "workspaces", wsId, "tasks", "tsk99.json"))).toBe(false);
			});
		} finally {
			cleanup();
		}
	});

	it("state ③: clone of a decoupled repo fetches + tracks the remote board branch", async () => {
		// Two machines = two HOMEs (two machine-rooted workspace indexes). The repo leaf
		// folder name is shared ("proj"), so the path-derived workspace id resolves the
		// same on each fresh index — the realistic clone-and-continue scenario.
		const { path: originParent, cleanup: cleanupOrigin } = createTempDir("kanban-decouple-origin-");
		const { path: cloneParent, cleanup: cleanupClone } = createTempDir("kanban-decouple-clone-");
		const { path: homeA, cleanup: cleanupHomeA } = createTempDir("kanban-decouple-homeA-");
		const { path: homeB, cleanup: cleanupHomeB } = createTempDir("kanban-decouple-homeB-");
		const originPath = join(originParent, "proj");
		const clonePath = join(cloneParent, "proj");
		try {
			let wsId = "";
			// Machine A: build + decouple the origin, with real board data committed.
			await withTemporaryHomeAt(homeA, async () => {
				spawnSync("mkdir", ["-p", originPath]);
				git(originPath, ["init", "-q", "-b", "main", "."]);
				git(originPath, ["commit", "-q", "--allow-empty", "-m", "init"]);
				const originCtx = await loadWorkspaceContext(originPath); // decouples origin
				expect(isBoardDecouplingActive(originPath)).toBe(true);
				wsId = originCtx.workspaceId;
				const initial = await loadWorkspaceState(originPath);
				await saveWorkspaceState(originPath, {
					board: singleTaskBoard("tskAA"),
					sessions: {},
					expectedRevision: initial.revision,
				});
				// P2 does not auto-commit board writes (that is P3) — commit the board
				// worktree by hand so the board branch carries the data a clone will fetch.
				git(getBoardWorktreePath(originPath), ["add", "-A"]);
				git(getBoardWorktreePath(originPath), ["commit", "-q", "-m", "board: data"]);
			});

			// Clone carries the code branch + the remote board branch + the pointer.
			git(cloneParent, ["clone", "-q", originPath, clonePath]);
			expect(existsSync(getBoardRefPath(clonePath))).toBe(true);

			// Machine B: first load bootstraps the board worktree from the remote branch.
			await withTemporaryHomeAt(homeB, async () => {
				const cloneCtx = await loadWorkspaceContext(clonePath);
				expect(cloneCtx.workspaceId).toBe(wsId);
				expect(cloneCtx.boardData.boardDataHome).toBe(getBoardWorktreeDataHome(clonePath));
				expect(existsSync(getBoardWorktreePath(clonePath))).toBe(true);

				const cloned = await loadWorkspaceState(clonePath);
				expect(cloned.board.columns.find((c) => c.id === "backlog")?.cards.map((c) => c.id)).toEqual(["tskAA"]);
				expect(
					existsSync(join(getBoardWorktreeDataHome(clonePath), "workspaces", wsId, "tasks", "tskAA.json")),
				).toBe(true);
			});
		} finally {
			cleanupHomeB();
			cleanupHomeA();
			cleanupClone();
			cleanupOrigin();
		}
	});

	it("idempotent: a second load does not re-migrate, re-commit, or change the code tree", async () => {
		const { path: parent, cleanup } = createTempDir("kanban-decouple-idem-");
		const repoPath = join(parent, "acme");
		try {
			await withTemporaryHome(async () => {
				spawnSync("mkdir", ["-p", repoPath]);
				git(repoPath, ["init", "-q", "-b", "main", "."]);
				git(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"]);
				await loadWorkspaceContext(repoPath);
				const headAfterFirst = git(repoPath, ["rev-parse", "HEAD"]);
				const boardHeadAfterFirst = git(getBoardWorktreePath(repoPath), ["rev-parse", "HEAD"]);

				// Drop the in-process "fully prepared" mark so the second load genuinely
				// re-runs the whole migration chain — that is what idempotency must prove,
				// not the cache short-circuit (which is covered separately).
				resetRepoRuntimeHomePreparedCacheForTests();
				await loadWorkspaceContext(repoPath);
				expect(git(repoPath, ["rev-parse", "HEAD"])).toBe(headAfterFirst);
				expect(git(getBoardWorktreePath(repoPath), ["rev-parse", "HEAD"])).toBe(boardHeadAfterFirst);
			});
		} finally {
			cleanup();
		}
	});

	it("in-process cache: a fully-decoupled repo is marked prepared and the mark is resettable", async () => {
		const { path: parent, cleanup } = createTempDir("kanban-decouple-cache-");
		const repoPath = join(parent, "acme");
		try {
			await withTemporaryHome(async () => {
				spawnSync("mkdir", ["-p", repoPath]);
				git(repoPath, ["init", "-q", "-b", "main", "."]);
				git(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"]);

				expect(isRepoRuntimeHomePreparedForTests(repoPath)).toBe(false);

				// Reaching the terminal decoupled state marks the repo prepared so later
				// loads in this process skip the whole migration chain.
				await loadWorkspaceContext(repoPath);
				expect(git(repoPath, ["ls-files", ".kanban/board-ref"])).toBe(".kanban/board-ref");
				expect(isRepoRuntimeHomePreparedForTests(repoPath)).toBe(true);

				resetRepoRuntimeHomePreparedCacheForTests();
				expect(isRepoRuntimeHomePreparedForTests(repoPath)).toBe(false);
			});
		} finally {
			cleanup();
		}
	});

	it("in-process cache: an unborn repo (no commit) is never marked prepared", async () => {
		const { path: parent, cleanup } = createTempDir("kanban-decouple-unborn-");
		const repoPath = join(parent, "acme");
		try {
			await withTemporaryHome(async () => {
				spawnSync("mkdir", ["-p", repoPath]);
				git(repoPath, ["init", "-q", "-b", "main", "."]);

				// No commit yet → decoupling cannot complete → the chain must keep re-running
				// on every load (and so must never be cached as fully prepared).
				await loadWorkspaceContext(repoPath);
				expect(git(repoPath, ["ls-files", ".kanban/board-ref"])).toBe("");
				expect(isRepoRuntimeHomePreparedForTests(repoPath)).toBe(false);
			});
		} finally {
			cleanup();
		}
	});

	it("end-to-end: switching code branches stays clean while the runtime rewrites the board", async () => {
		const { path: parent, cleanup } = createTempDir("kanban-decouple-switch-");
		const repoPath = join(parent, "acme");
		try {
			await withTemporaryHome(async () => {
				spawnSync("mkdir", ["-p", repoPath]);
				git(repoPath, ["init", "-q", "-b", "main", "."]);
				git(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"]);
				git(repoPath, ["branch", "feature"]);

				await loadWorkspaceContext(repoPath); // decouples
				// Runtime churns the board (the pre-decouple dirtiness source).
				let state = await loadWorkspaceState(repoPath);
				await saveWorkspaceState(repoPath, {
					board: singleTaskBoard("tsk01"),
					sessions: {},
					expectedRevision: state.revision,
				});
				state = await loadWorkspaceState(repoPath);
				await saveWorkspaceState(repoPath, {
					board: singleTaskBoard("tsk02"),
					sessions: {},
					expectedRevision: state.revision,
				});

				// The code tree is clean despite all that board churn → switch succeeds.
				expect(gitStatus(repoPath)).toBe("");
				git(repoPath, ["switch", "-q", "feature"]);
				expect(git(repoPath, ["symbolic-ref", "--short", "HEAD"])).toBe("feature");
				git(repoPath, ["switch", "-q", "main"]);

				// The board survived the switch and is still served from the worktree.
				const after = await loadWorkspaceState(repoPath);
				expect(after.board.columns.find((c) => c.id === "backlog")?.cards.map((c) => c.id)).toEqual(["tsk02"]);
			});
		} finally {
			cleanup();
		}
	});
});
