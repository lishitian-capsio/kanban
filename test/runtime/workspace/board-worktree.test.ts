import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeBoardRef } from "../../../src/state/board-ref";
import {
	createOrphanBranchViaPlumbing,
	ensureBoardWorktree,
	getBoardWorktreeDataHome,
	getBoardWorktreePath,
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
