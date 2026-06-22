import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeBoardRef } from "../../../src/state/board-ref";
import {
	boardWorktreeHasCommittedData,
	commitBoardWorktree,
	createOrphanBranchViaPlumbing,
	ensureBoardWorktree,
	fetchAndFastForwardBoardWorktree,
	getBoardWorktreeAheadBehind,
	getBoardWorktreeDataHome,
	getBoardWorktreePath,
	pullBoardWorktree,
	pushBoardWorktree,
	renameBoardBranch,
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

/**
 * Build a bare remote plus two clones (`a`, `b`) of it, each on `main` with an `origin`
 * pointing at the bare remote — the two-machine setup the push/pull paths reconcile.
 */
function makeRemoteAndClones(prefix: string): {
	cloneA: string;
	cloneB: string;
	cleanups: Array<() => void>;
} {
	const seed = initRepo(`${prefix}seed-`);
	const bareParent = createTempDir(`${prefix}bare-`);
	const remote = join(bareParent.path, "remote.git");
	git(bareParent.path, ["clone", "--bare", "-q", seed.repoPath, remote]);

	const cloneParentA = createTempDir(`${prefix}a-`);
	const cloneParentB = createTempDir(`${prefix}b-`);
	const cloneA = join(cloneParentA.path, "a");
	const cloneB = join(cloneParentB.path, "b");
	git(cloneParentA.path, ["clone", "-q", remote, cloneA]);
	git(cloneParentB.path, ["clone", "-q", remote, cloneB]);

	return {
		cloneA,
		cloneB,
		cleanups: [cloneParentA.cleanup, cloneParentB.cleanup, bareParent.cleanup, seed.cleanup],
	};
}

function dataFile(repoPath: string, name: string): string {
	return join(getBoardWorktreeDataHome(repoPath), "files", name);
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

	it("orphans an empty branch when the remote is reachable but genuinely lacks the board branch", async () => {
		// A reachable origin that simply has no board branch yet (brand-new project on the
		// other side): the fetch fails with a "couldn't find remote ref" error, which is the
		// legitimate degradation — orphan a fresh empty branch rather than surfacing an error.
		const { repoPath: origin, cleanup: cleanupOrigin } = initRepo("kanban-board-origin-");
		const { path: cloneParent, cleanup: cleanupClone } = createTempDir("kanban-board-clone-");
		try {
			const clonePath = join(cloneParent, "clone");
			git(cloneParent, ["clone", "-q", origin, clonePath]);

			const result = await setupBoardWorktree(clonePath, "kanban/board");
			expect(result.ok).toBe(true);
			expect(result.created).toBe(true);
			expect(await boardWorktreeHasCommittedData(clonePath)).toBe(false);
			expect(git(getBoardWorktreePath(clonePath), ["symbolic-ref", "--short", "HEAD"])).toBe("kanban/board");
		} finally {
			cleanupClone();
			cleanupOrigin();
		}
	});

	it("fails clearly instead of orphaning an empty board when the remote is unreachable", async () => {
		// A cold clone whose board branch lives on a remote we can't reach (offline / slow /
		// timed out). The fetch fails with a non-"missing ref" error; silently orphaning an
		// empty branch here would mask the real board data on the remote, so setup must fail
		// loudly (and the next boot retries) rather than emptying the board. A timeout SIGKILL
		// produces the same failure class, so this also stands in for the timeout exit.
		const { repoPath: origin, cleanup: cleanupOrigin } = initRepo("kanban-board-origin-");
		const { path: cloneParent, cleanup: cleanupClone } = createTempDir("kanban-board-clone-");
		try {
			const clonePath = join(cloneParent, "clone");
			git(cloneParent, ["clone", "-q", origin, clonePath]);
			// Point origin at a path that is not a git repository → fetch fails fast with a
			// connection-class error rather than "couldn't find remote ref".
			git(clonePath, ["remote", "set-url", "origin", join(cloneParent, "does-not-exist")]);

			const result = await setupBoardWorktree(clonePath, "kanban/board");
			expect(result.ok).toBe(false);
			expect(result.error).toBeTruthy();
			// Crucially, no divergent empty board branch was orphaned over the remote's data...
			expect(
				spawnSync("git", ["-C", clonePath, "rev-parse", "--verify", "refs/heads/kanban/board"]).status,
			).not.toBe(0);
			// ...and no worktree was left behind.
			expect(existsSync(getBoardWorktreePath(clonePath))).toBe(false);
		} finally {
			cleanupClone();
			cleanupOrigin();
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

describe("pushBoardWorktree", () => {
	it("reports no-remote for a remote-less repo (data stays durable locally)", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-push-");
		try {
			await setupBoardWorktree(repoPath, "kanban/board");
			writeFileEnsuringDir(dataFile(repoPath, "a.txt"), "1");
			await commitBoardWorktree(repoPath, "board: seed");
			const result = await pushBoardWorktree(repoPath, "kanban/board");
			expect(result.status).toBe("no-remote");
			expect(result.pulledChanges).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("fast-forward pushes when local is ahead of the remote", async () => {
		const { cloneA, cleanups } = makeRemoteAndClones("kanban-board-push-");
		try {
			await setupBoardWorktree(cloneA, "kanban/board");
			writeFileEnsuringDir(dataFile(cloneA, "a.txt"), "1");
			await commitBoardWorktree(cloneA, "board: seed");
			const result = await pushBoardWorktree(cloneA, "kanban/board");
			expect(result.status).toBe("pushed");
			expect(result.pulledChanges).toBe(false);
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});

	it("integrates a non-conflicting remote (different files) then re-pushes", async () => {
		const { cloneA, cloneB, cleanups } = makeRemoteAndClones("kanban-board-push-");
		try {
			// Both clones start from the same seeded board branch.
			await setupBoardWorktree(cloneA, "kanban/board");
			writeFileEnsuringDir(dataFile(cloneA, "a.txt"), "from-a");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");
			await setupBoardWorktree(cloneB, "kanban/board");

			// B publishes a change to a different file, moving the remote ahead.
			writeFileEnsuringDir(dataFile(cloneB, "b.txt"), "from-b");
			await commitBoardWorktree(cloneB, "board: b change");
			expect((await pushBoardWorktree(cloneB, "kanban/board")).status).toBe("pushed");

			// A's push is rejected, so it merges B's commit in and re-pushes.
			writeFileEnsuringDir(dataFile(cloneA, "a2.txt"), "from-a-again");
			await commitBoardWorktree(cloneA, "board: a change");
			const result = await pushBoardWorktree(cloneA, "kanban/board");
			expect(result.status).toBe("integrated-and-pushed");
			expect(result.pulledChanges).toBe(true);
			// A now holds both sides of the merge.
			expect(existsSync(dataFile(cloneA, "a2.txt"))).toBe(true);
			expect(existsSync(dataFile(cloneA, "b.txt"))).toBe(true);
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});

	it("surfaces a conflict without destroying local data when the same file diverged", async () => {
		const { cloneA, cloneB, cleanups } = makeRemoteAndClones("kanban-board-push-");
		try {
			await setupBoardWorktree(cloneA, "kanban/board");
			writeFileEnsuringDir(dataFile(cloneA, "shared.txt"), "base\n");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");
			await setupBoardWorktree(cloneB, "kanban/board");

			// B edits the shared file and pushes.
			writeFileEnsuringDir(dataFile(cloneB, "shared.txt"), "from-b\n");
			await commitBoardWorktree(cloneB, "board: b edit");
			await pushBoardWorktree(cloneB, "kanban/board");

			// A edits the same file differently; the merge conflicts.
			writeFileEnsuringDir(dataFile(cloneA, "shared.txt"), "from-a\n");
			await commitBoardWorktree(cloneA, "board: a edit");
			const headBefore = git(getBoardWorktreePath(cloneA), ["rev-parse", "HEAD"]);
			const result = await pushBoardWorktree(cloneA, "kanban/board");

			expect(result.status).toBe("conflict");
			expect(result.pulledChanges).toBe(false);
			// The merge was aborted: A's local data is intact, no conflict markers, HEAD unmoved.
			expect(readFileSync(dataFile(cloneA, "shared.txt"), "utf8")).toBe("from-a\n");
			expect(git(getBoardWorktreePath(cloneA), ["rev-parse", "HEAD"])).toBe(headBefore);
			expect(git(getBoardWorktreePath(cloneA), ["status", "--porcelain"])).toBe("");
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});
});

describe("fetchAndFastForwardBoardWorktree", () => {
	it("fast-forwards a behind worktree to the remote tip and reports the change", async () => {
		const { cloneA, cloneB, cleanups } = makeRemoteAndClones("kanban-board-ff-");
		try {
			// A seeds + publishes; B tracks it at that point.
			await setupBoardWorktree(cloneA, "kanban/board");
			writeFileEnsuringDir(dataFile(cloneA, "a.txt"), "1");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");
			await setupBoardWorktree(cloneB, "kanban/board");

			// A publishes a newer commit; B is now strictly behind.
			writeFileEnsuringDir(dataFile(cloneA, "a2.txt"), "2");
			await commitBoardWorktree(cloneA, "board: more");
			await pushBoardWorktree(cloneA, "kanban/board");

			const result = await fetchAndFastForwardBoardWorktree(cloneB, "kanban/board");
			expect(result.changed).toBe(true);
			expect(existsSync(dataFile(cloneB, "a2.txt"))).toBe(true);

			// A second reconcile with nothing new is a no-op.
			expect((await fetchAndFastForwardBoardWorktree(cloneB, "kanban/board")).changed).toBe(false);
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});

	it("is a no-op for a remote-less repo", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-ff-");
		try {
			await setupBoardWorktree(repoPath, "kanban/board");
			expect((await fetchAndFastForwardBoardWorktree(repoPath, "kanban/board")).changed).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe("getBoardWorktreeAheadBehind", () => {
	it("reports no remote for a remote-less repo", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-ab-");
		try {
			await setupBoardWorktree(repoPath, "kanban/board");
			const ab = await getBoardWorktreeAheadBehind(repoPath, "kanban/board");
			expect(ab).toEqual({ exists: true, hasRemote: false, hasRemoteRef: false, aheadCount: 0, behindCount: 0 });
		} finally {
			cleanup();
		}
	});

	it("counts ahead after a local commit, then synced after a push", async () => {
		const { cloneA, cleanups } = makeRemoteAndClones("kanban-board-ab-");
		try {
			await setupBoardWorktree(cloneA, "kanban/board");
			writeFileEnsuringDir(dataFile(cloneA, "a.txt"), "1");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");
			expect(await getBoardWorktreeAheadBehind(cloneA, "kanban/board")).toMatchObject({
				hasRemoteRef: true,
				aheadCount: 0,
				behindCount: 0,
			});

			// A local commit that has not been pushed shows as ahead.
			writeFileEnsuringDir(dataFile(cloneA, "a2.txt"), "2");
			await commitBoardWorktree(cloneA, "board: more");
			expect(await getBoardWorktreeAheadBehind(cloneA, "kanban/board")).toMatchObject({
				aheadCount: 1,
				behindCount: 0,
			});
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});

	it("reflects divergence after a fetch when both sides advanced", async () => {
		const { cloneA, cloneB, cleanups } = makeRemoteAndClones("kanban-board-ab-");
		try {
			await setupBoardWorktree(cloneA, "kanban/board");
			writeFileEnsuringDir(dataFile(cloneA, "a.txt"), "1");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");
			await setupBoardWorktree(cloneB, "kanban/board");

			// B advances the remote.
			writeFileEnsuringDir(dataFile(cloneB, "b.txt"), "2");
			await commitBoardWorktree(cloneB, "board: b");
			await pushBoardWorktree(cloneB, "kanban/board");

			// A commits locally (not pushed) → diverged from the remote.
			writeFileEnsuringDir(dataFile(cloneA, "a2.txt"), "3");
			await commitBoardWorktree(cloneA, "board: a");

			// A fetches; no fast-forward is possible (diverged), so both counts are visible.
			await fetchAndFastForwardBoardWorktree(cloneA, "kanban/board");
			expect(await getBoardWorktreeAheadBehind(cloneA, "kanban/board")).toMatchObject({
				aheadCount: 1,
				behindCount: 1,
			});
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});
});

describe("pullBoardWorktree", () => {
	it("fast-forwards in the remote changes", async () => {
		const { cloneA, cloneB, cleanups } = makeRemoteAndClones("kanban-board-pull-");
		try {
			await setupBoardWorktree(cloneA, "kanban/board");
			writeFileEnsuringDir(dataFile(cloneA, "a.txt"), "1");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");
			await setupBoardWorktree(cloneB, "kanban/board");

			writeFileEnsuringDir(dataFile(cloneA, "a2.txt"), "2");
			await commitBoardWorktree(cloneA, "board: more");
			await pushBoardWorktree(cloneA, "kanban/board");

			const result = await pullBoardWorktree(cloneB, "kanban/board");
			expect(result.status).toBe("pulled");
			expect(result.pulledChanges).toBe(true);
			expect(existsSync(dataFile(cloneB, "a2.txt"))).toBe(true);

			// Nothing left to pull.
			expect((await pullBoardWorktree(cloneB, "kanban/board")).status).toBe("up-to-date");
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});

	it("surfaces a conflict without destroying local data", async () => {
		const { cloneA, cloneB, cleanups } = makeRemoteAndClones("kanban-board-pull-");
		try {
			await setupBoardWorktree(cloneA, "kanban/board");
			writeFileEnsuringDir(dataFile(cloneA, "shared.txt"), "base\n");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");
			await setupBoardWorktree(cloneB, "kanban/board");

			writeFileEnsuringDir(dataFile(cloneB, "shared.txt"), "from-b\n");
			await commitBoardWorktree(cloneB, "board: b edit");
			await pushBoardWorktree(cloneB, "kanban/board");

			writeFileEnsuringDir(dataFile(cloneA, "shared.txt"), "from-a\n");
			await commitBoardWorktree(cloneA, "board: a edit");
			const result = await pullBoardWorktree(cloneA, "kanban/board");

			expect(result.status).toBe("conflict");
			expect(readFileSync(dataFile(cloneA, "shared.txt"), "utf8")).toBe("from-a\n");
			expect(git(getBoardWorktreePath(cloneA), ["status", "--porcelain"])).toBe("");
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});
});

describe("renameBoardBranch", () => {
	it("renames a remote-less board branch, carrying data and archiving the old tip", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-rename-");
		try {
			await setupBoardWorktree(repoPath, "kanban/board");
			writeFileEnsuringDir(dataFile(repoPath, "doc.md"), "hi");
			await commitBoardWorktree(repoPath, "board: seed");
			const oldTip = git(getBoardWorktreePath(repoPath), ["rev-parse", "HEAD"]);

			const result = await renameBoardBranch(repoPath, "kanban/board", "kanban/data");
			expect(result.ok).toBe(true);
			expect(result.archivedTag).toMatch(/^kanban\/board-archive\//);

			// The worktree is on the new branch and the data came along.
			expect(git(getBoardWorktreePath(repoPath), ["symbolic-ref", "--short", "HEAD"])).toBe("kanban/data");
			expect(existsSync(dataFile(repoPath, "doc.md"))).toBe(true);
			// The old branch is retired but the archive tag preserves its tip.
			expect(spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", "refs/heads/kanban/board"]).status).not.toBe(
				0,
			);
			if (result.archivedTag) {
				expect(git(repoPath, ["rev-parse", `refs/tags/${result.archivedTag}`])).toBe(oldTip);
			}
		} finally {
			cleanup();
		}
	});

	it("publishes the new branch and deletes the old one on the remote", async () => {
		const { cloneA, cleanups } = makeRemoteAndClones("kanban-board-rename-");
		try {
			await setupBoardWorktree(cloneA, "kanban/board");
			writeFileEnsuringDir(dataFile(cloneA, "doc.md"), "hi");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");

			const result = await renameBoardBranch(cloneA, "kanban/board", "kanban/data");
			expect(result.ok).toBe(true);

			// The remote now carries the new branch and no longer the old one.
			expect(git(cloneA, ["ls-remote", "--heads", "origin", "kanban/data"])).not.toBe("");
			expect(git(cloneA, ["ls-remote", "--heads", "origin", "kanban/board"])).toBe("");
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});

	it("is a no-op when the name is unchanged", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-rename-");
		try {
			await setupBoardWorktree(repoPath, "kanban/board");
			const result = await renameBoardBranch(repoPath, "kanban/board", "kanban/board");
			expect(result.ok).toBe(true);
			expect(result.archivedTag).toBeNull();
			expect(git(getBoardWorktreePath(repoPath), ["symbolic-ref", "--short", "HEAD"])).toBe("kanban/board");
		} finally {
			cleanup();
		}
	});

	it("refuses to clobber an existing branch and leaves the old branch in place", async () => {
		const { repoPath, cleanup } = initRepo("kanban-board-rename-");
		try {
			await setupBoardWorktree(repoPath, "kanban/board");
			await commitBoardWorktree(repoPath, "board: noop");
			git(repoPath, ["branch", "kanban/taken", "kanban/board"]);

			const result = await renameBoardBranch(repoPath, "kanban/board", "kanban/taken");
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/already exists/);
			// Still on the old branch — nothing was abandoned.
			expect(git(getBoardWorktreePath(repoPath), ["symbolic-ref", "--short", "HEAD"])).toBe("kanban/board");
		} finally {
			cleanup();
		}
	});
});
