import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { writeBoardRef } from "../../../src/state/board-ref";
import { createBoardSyncService } from "../../../src/workspace/board-sync";
import {
	commitBoardWorktree,
	getBoardWorktreeDataHome,
	getBoardWorktreePath,
	pushBoardWorktree,
	setupBoardWorktree,
} from "../../../src/workspace/board-worktree";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function writeData(repoPath: string, name: string, contents: string): void {
	const filePath = join(getBoardWorktreeDataHome(repoPath), "files", name);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents, "utf8");
}

function boardCommitCount(repoPath: string): number {
	return Number.parseInt(git(getBoardWorktreePath(repoPath), ["rev-list", "--count", "HEAD"]), 10);
}

function target(repoPath: string) {
	return { repoPath, workspaceId: "ws-1", workspacePath: repoPath };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** A repo with board-branch decoupling activated (board-ref + an initialized board worktree). */
async function makeDecoupledRepo(prefix: string): Promise<{ repoPath: string; cleanup: () => void }> {
	const { path: repoPath, cleanup } = createTempDir(prefix);
	git(repoPath, ["init", "-q", "-b", "main", "."]);
	git(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"]);
	await writeBoardRef(repoPath, { version: 1, branch: "kanban/board" });
	await setupBoardWorktree(repoPath, "kanban/board");
	return { repoPath, cleanup };
}

function makeRemoteDecoupledClones(prefix: string): {
	cloneA: string;
	cloneB: string;
	cleanups: Array<() => void>;
} {
	const seed = createTempDir(`${prefix}seed-`);
	git(seed.path, ["init", "-q", "-b", "main", "."]);
	git(seed.path, ["commit", "-q", "--allow-empty", "-m", "init"]);
	const bareParent = createTempDir(`${prefix}bare-`);
	const remote = join(bareParent.path, "remote.git");
	git(bareParent.path, ["clone", "--bare", "-q", seed.path, remote]);

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

describe("createBoardSyncService", () => {
	it("is a no-op when board-branch decoupling is not active", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-board-sync-");
		try {
			git(repoPath, ["init", "-q", "-b", "main", "."]);
			git(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"]);
			const broadcast = vi.fn();
			const service = createBoardSyncService({ broadcastWorkspaceState: broadcast, debounceMs: 10 });

			// No board-ref → scheduleSync and flush do nothing (no board worktree to touch).
			service.scheduleSync(target(repoPath));
			await service.flush(repoPath);
			expect(broadcast).not.toHaveBeenCalled();
			await service.dispose();
		} finally {
			cleanup();
		}
	});

	it("flush commits pending board writes (and is idempotent on a clean tree)", async () => {
		const { repoPath, cleanup } = await makeDecoupledRepo("kanban-board-sync-");
		try {
			const service = createBoardSyncService({ broadcastWorkspaceState: vi.fn(), debounceMs: 10 });
			const before = boardCommitCount(repoPath);

			writeData(repoPath, "a.txt", "1");
			service.scheduleSync(target(repoPath));
			await service.flush(repoPath);
			expect(boardCommitCount(repoPath)).toBe(before + 1);

			// Nothing new to commit → no extra commit.
			await service.flush(repoPath);
			expect(boardCommitCount(repoPath)).toBe(before + 1);
			await service.dispose();
		} finally {
			cleanup();
		}
	});

	it("coalesces a burst of debounced writes into a single commit", async () => {
		const { repoPath, cleanup } = await makeDecoupledRepo("kanban-board-sync-");
		try {
			const service = createBoardSyncService({ broadcastWorkspaceState: vi.fn(), debounceMs: 30 });
			const before = boardCommitCount(repoPath);

			writeData(repoPath, "a.txt", "1");
			service.scheduleSync(target(repoPath));
			writeData(repoPath, "b.txt", "2");
			service.scheduleSync(target(repoPath));
			writeData(repoPath, "c.txt", "3");
			service.scheduleSync(target(repoPath));

			await waitFor(() => boardCommitCount(repoPath) === before + 1);
			// All three files landed in the one coalesced commit.
			expect(existsSync(join(getBoardWorktreeDataHome(repoPath), "files", "c.txt"))).toBe(true);
			await service.dispose();
			expect(boardCommitCount(repoPath)).toBe(before + 1);
		} finally {
			cleanup();
		}
	});

	it("syncOnStartup fast-forwards from the remote and rebroadcasts once", async () => {
		const { cloneA, cloneB, cleanups } = makeRemoteDecoupledClones("kanban-board-sync-");
		try {
			await writeBoardRef(cloneA, { version: 1, branch: "kanban/board" });
			await writeBoardRef(cloneB, { version: 1, branch: "kanban/board" });

			// A seeds + publishes the board branch; B tracks it.
			await setupBoardWorktree(cloneA, "kanban/board");
			writeData(cloneA, "a.txt", "1");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");
			await setupBoardWorktree(cloneB, "kanban/board");

			// A publishes more; B is now behind.
			writeData(cloneA, "a2.txt", "2");
			await commitBoardWorktree(cloneA, "board: more");
			await pushBoardWorktree(cloneA, "kanban/board");

			const broadcast = vi.fn();
			const service = createBoardSyncService({ broadcastWorkspaceState: broadcast, debounceMs: 10 });
			await service.syncOnStartup(target(cloneB));

			expect(existsSync(join(getBoardWorktreeDataHome(cloneB), "files", "a2.txt"))).toBe(true);
			expect(broadcast).toHaveBeenCalledTimes(1);

			// Idempotent: a second startup reconcile does nothing (already done this session).
			await service.syncOnStartup(target(cloneB));
			expect(broadcast).toHaveBeenCalledTimes(1);
			await service.dispose();
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});

	it("surfaces a remote conflict on sync without destroying local data or broadcasting", async () => {
		const { cloneA, cloneB, cleanups } = makeRemoteDecoupledClones("kanban-board-sync-");
		try {
			await writeBoardRef(cloneA, { version: 1, branch: "kanban/board" });
			await writeBoardRef(cloneB, { version: 1, branch: "kanban/board" });

			await setupBoardWorktree(cloneA, "kanban/board");
			writeData(cloneA, "shared.txt", "base\n");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");
			await setupBoardWorktree(cloneB, "kanban/board");

			// B publishes a conflicting edit to the shared file.
			writeData(cloneB, "shared.txt", "from-b\n");
			await commitBoardWorktree(cloneB, "board: b edit");
			await pushBoardWorktree(cloneB, "kanban/board");

			// A edits the same file and syncs via the service → conflict, surfaced.
			const broadcast = vi.fn();
			const service = createBoardSyncService({ broadcastWorkspaceState: broadcast, debounceMs: 10 });
			writeData(cloneA, "shared.txt", "from-a\n");
			service.scheduleSync(target(cloneA));
			await service.flush(cloneA);

			// Local data is intact (no conflict markers, clean tree) and no pull broadcast fired.
			expect(readFileSync(join(getBoardWorktreeDataHome(cloneA), "files", "shared.txt"), "utf8")).toBe("from-a\n");
			expect(git(getBoardWorktreePath(cloneA), ["status", "--porcelain"])).toBe("");
			expect(broadcast).not.toHaveBeenCalled();
			await service.dispose();
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});
});
