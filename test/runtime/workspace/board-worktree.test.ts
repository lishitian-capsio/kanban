import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeBoardRef } from "../../../src/state/board-ref";
import {
	boardWorktreeHasCommittedData,
	commitBoardWorktree,
	createOrphanBranchViaPlumbing,
	ensureBoardWorktree,
	getBoardWorktreeDataHome,
	getBoardWorktreePath,
	setupBoardWorktree,
} from "../../../src/workspace/board-worktree";
import { BOARD_WORKTREE_SENTINEL } from "../../../src/workspace/task-worktree-path";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function initRepo(prefix: string): { repoPath: string; cleanup: () => void } {
	const { path: repoPath, cleanup } = createTempDir(prefix);
	git(repoPath, ["init", "-q", "-b", "main", "."]);
	git(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"]);
	return { repoPath, cleanup };
}

function writeFileEnsuringDir(filePath: string, contents: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents, "utf8");
}

describe("board-worktree paths", () => {
	it("places the board worktree under the sentinel inside the gitignored worktrees root", () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-board-wt-");
		try {
			const worktreePath = getBoardWorktreePath(repoPath);
			expect(worktreePath).toContain(join(".kanban", "worktrees", BOARD_WORKTREE_SENTINEL));
			expect(getBoardWorktreeDataHome(repoPath)).toBe(join(worktreePath, ".kanban"));
		} finally {
			cleanup();
		}
	});
});

describe("createOrphanBranchViaPlumbing", () => {
	it("creates a branch rooted at a parentless empty-tree commit", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-wt-");
		try {
			const commit = await createOrphanBranchViaPlumbing(repoPath, "kanban/board");
			expect(commit).toMatch(/^[0-9a-f]{40}$/);
			// Branch exists and points at the returned commit.
			expect(git(repoPath, ["rev-parse", "refs/heads/kanban/board"])).toBe(commit);
			// The commit has no parent and an empty tree (no files).
			expect(git(repoPath, ["rev-list", "--count", commit])).toBe("1");
			expect(git(repoPath, ["ls-tree", "--name-only", commit])).toBe("");
		} finally {
			cleanup();
		}
	});
});

describe("ensureBoardWorktree", () => {
	it("is a no-op when board-branch decoupling is not active (no board-ref)", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-wt-");
		try {
			const result = await ensureBoardWorktree(repoPath);
			expect(result.ok).toBe(true);
			expect(result.path).toBeNull();
			expect(result.created).toBe(false);
			expect(existsSync(getBoardWorktreePath(repoPath))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("creates the board worktree on the configured branch once board-ref is present", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-wt-");
		try {
			await writeBoardRef(repoPath, { version: 1, branch: "kanban/board" });

			const result = await ensureBoardWorktree(repoPath);
			expect(result.ok).toBe(true);
			expect(result.created).toBe(true);
			expect(result.path).toBe(getBoardWorktreePath(repoPath));
			expect(existsSync(getBoardWorktreePath(repoPath))).toBe(true);

			// The worktree is checked out on the board branch.
			expect(git(getBoardWorktreePath(repoPath), ["symbolic-ref", "--short", "HEAD"])).toBe("kanban/board");
		} finally {
			cleanup();
		}
	});

	it("is idempotent: a second ensure reuses the existing worktree", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-wt-");
		try {
			await writeBoardRef(repoPath, { version: 1, branch: "kanban/board" });
			await ensureBoardWorktree(repoPath);

			const second = await ensureBoardWorktree(repoPath);
			expect(second.ok).toBe(true);
			expect(second.created).toBe(false);
			expect(second.path).toBe(getBoardWorktreePath(repoPath));
		} finally {
			cleanup();
		}
	});

	it("honors a custom board branch name from the pointer", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-wt-");
		try {
			await writeBoardRef(repoPath, { version: 1, branch: "kanban/data" });

			const result = await ensureBoardWorktree(repoPath);
			expect(result.ok).toBe(true);
			expect(result.branch).toBe("kanban/data");
			expect(git(getBoardWorktreePath(repoPath), ["symbolic-ref", "--short", "HEAD"])).toBe("kanban/data");
		} finally {
			cleanup();
		}
	});
});

describe("setupBoardWorktree clone bootstrap", () => {
	it("fetches and tracks an existing remote board branch instead of orphaning a new one", async () => {
		// Build an "origin" repo that already carries a board branch with data, then a
		// clone of it that only has the code branch — the clone case (state ③).
		const { repoPath: origin, cleanup: cleanupOrigin } = initRepo("kanban-board-origin-");
		const { path: cloneParent, cleanup: cleanupClone } = createTempDir("kanban-board-clone-");
		try {
			await setupBoardWorktree(origin, "kanban/board");
			writeFileEnsuringDir(join(getBoardWorktreeDataHome(origin), "files", "marker.txt"), "from-origin");
			await commitBoardWorktree(origin, "board: seed");

			const clonePath = join(cloneParent, "clone");
			git(cloneParent, ["clone", "-q", origin, clonePath]);
			// The clone has no local board branch...
			expect(
				spawnSync("git", ["-C", clonePath, "rev-parse", "--verify", "refs/heads/kanban/board"]).status,
			).not.toBe(0);
			// ...but origin/kanban/board is present, so setup tracks it rather than orphaning.
			const result = await setupBoardWorktree(clonePath, "kanban/board");
			expect(result.ok).toBe(true);
			expect(result.created).toBe(true);
			expect(git(getBoardWorktreePath(clonePath), ["symbolic-ref", "--short", "HEAD"])).toBe("kanban/board");
			expect(existsSync(join(getBoardWorktreeDataHome(clonePath), "files", "marker.txt"))).toBe(true);
			// The tracking branch is wired to the remote.
			expect(git(clonePath, ["config", "branch.kanban/board.remote"])).toBe("origin");
		} finally {
			cleanupClone();
			cleanupOrigin();
		}
	});

	it("orphans a fresh empty branch when no remote carries the board branch", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-wt-");
		try {
			const result = await setupBoardWorktree(repoPath, "kanban/board");
			expect(result.ok).toBe(true);
			expect(result.created).toBe(true);
			expect(await boardWorktreeHasCommittedData(repoPath)).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe("commitBoardWorktree / boardWorktreeHasCommittedData", () => {
	it("reports no data on a fresh orphan branch and data after a seed commit", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-wt-");
		try {
			await setupBoardWorktree(repoPath, "kanban/board");
			expect(await boardWorktreeHasCommittedData(repoPath)).toBe(false);
			// An empty commit attempt is a no-op.
			expect(await commitBoardWorktree(repoPath, "board: noop")).toBe(false);

			writeFileEnsuringDir(join(getBoardWorktreeDataHome(repoPath), "files", "doc.md"), "hi");
			expect(await commitBoardWorktree(repoPath, "board: seed")).toBe(true);
			expect(await boardWorktreeHasCommittedData(repoPath)).toBe(true);
		} finally {
			cleanup();
		}
	});
});
