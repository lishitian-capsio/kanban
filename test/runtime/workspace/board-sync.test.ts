import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { RuntimeBoardSyncStatus } from "../../../src/core/api-contract";
import { readBoardRef, writeBoardRef } from "../../../src/state/board-ref";
import { type BoardSyncTarget, createBoardSyncService } from "../../../src/workspace/board-sync";
import {
	commitBoardWorktree,
	getBoardWorktreeDataHome,
	getBoardWorktreePath,
	isBoardAdoptPending,
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

	it("the debounced auto path commits locally but never pushes to the remote", async () => {
		const { cloneA, cleanups } = makeRemoteDecoupledClones("kanban-board-sync-");
		try {
			await writeBoardRef(cloneA, { version: 1, branch: "kanban/board" });
			await setupBoardWorktree(cloneA, "kanban/board");
			// Seed + publish so the remote-tracking ref is up to date (synced, ahead 0).
			writeData(cloneA, "a.txt", "1");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");

			const broadcast = vi.fn();
			const service = createBoardSyncService({ broadcastWorkspaceState: broadcast, debounceMs: 10 });
			const before = boardCommitCount(cloneA);

			// A committed-data write goes through the (auto) debounce path.
			writeData(cloneA, "a2.txt", "2");
			service.scheduleSync(target(cloneA));
			await service.flush(cloneA);

			// It committed locally...
			expect(boardCommitCount(cloneA)).toBe(before + 1);
			// ...but did NOT push: the worktree is now ahead of the (unchanged) remote-tracking
			// ref, and no pull-driven rebroadcast fired. The auto path is purely local.
			expect(await service.getStatus(target(cloneA))).toMatchObject({ state: "ahead", aheadCount: 1 });
			expect(broadcast).not.toHaveBeenCalled();
			await service.dispose();
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});

	it("pushNow surfaces a remote conflict without destroying local data or broadcasting", async () => {
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

			// A edits the same file and pushes via the explicit path → conflict, surfaced.
			const broadcast = vi.fn();
			const service = createBoardSyncService({ broadcastWorkspaceState: broadcast, debounceMs: 10 });
			writeData(cloneA, "shared.txt", "from-a\n");
			const result = await service.pushNow(target(cloneA));

			expect(result.ok).toBe(false);
			expect(result.status).toMatchObject({ state: "conflict" });
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

describe("createBoardSyncService status + controls", () => {
	it("reports a disabled status when decoupling is not active", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-board-status-");
		try {
			git(repoPath, ["init", "-q", "-b", "main", "."]);
			git(repoPath, ["commit", "-q", "--allow-empty", "-m", "init"]);
			const service = createBoardSyncService({ broadcastWorkspaceState: vi.fn(), debounceMs: 10 });
			const status = await service.getStatus(target(repoPath));
			expect(status).toMatchObject({
				state: "disabled",
				decoupled: false,
				branch: null,
				hasRemote: false,
				worktreePath: null,
			});
			await service.dispose();
		} finally {
			cleanup();
		}
	});

	it("reports local-only for a decoupled remote-less repo", async () => {
		const { repoPath, cleanup } = await makeDecoupledRepo("kanban-board-status-");
		try {
			const service = createBoardSyncService({ broadcastWorkspaceState: vi.fn(), debounceMs: 10 });
			const status = await service.getStatus(target(repoPath));
			expect(status).toMatchObject({
				state: "local-only",
				decoupled: true,
				branch: "kanban/board",
				hasRemote: false,
				worktreePath: getBoardWorktreePath(repoPath),
			});
			await service.dispose();
		} finally {
			cleanup();
		}
	});

	it("reports ahead when there is an unpushed local commit, then synced after pushNow", async () => {
		const { cloneA, cleanups } = makeRemoteDecoupledClones("kanban-board-status-");
		try {
			await writeBoardRef(cloneA, { version: 1, branch: "kanban/board" });
			await setupBoardWorktree(cloneA, "kanban/board");
			writeData(cloneA, "a.txt", "1");
			await commitBoardWorktree(cloneA, "board: seed");
			await pushBoardWorktree(cloneA, "kanban/board");

			// A local commit that has not been published shows as ahead.
			writeData(cloneA, "a2.txt", "2");
			await commitBoardWorktree(cloneA, "board: more");

			const statuses: RuntimeBoardSyncStatus[] = [];
			const service = createBoardSyncService({
				broadcastWorkspaceState: vi.fn(),
				onStatusChanged: (_target: BoardSyncTarget, status) => {
					statuses.push(status);
				},
				debounceMs: 10,
			});
			expect(await service.getStatus(target(cloneA))).toMatchObject({ state: "ahead", aheadCount: 1 });

			const result = await service.pushNow(target(cloneA));
			expect(result.ok).toBe(true);
			expect(result.status).toMatchObject({ state: "synced", aheadCount: 0 });
			// The push emitted at least one status broadcast (syncing → synced).
			expect(statuses.some((status) => status.state === "synced")).toBe(true);
			await service.dispose();
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});

	it("pausing auto-sync suppresses the debounced commit; resuming flushes it", async () => {
		const { repoPath, cleanup } = await makeDecoupledRepo("kanban-board-pause-");
		try {
			const service = createBoardSyncService({ broadcastWorkspaceState: vi.fn(), debounceMs: 20 });
			const before = boardCommitCount(repoPath);

			const paused = await service.setAutoSyncPaused(target(repoPath), true);
			expect(paused.autoSyncPaused).toBe(true);

			writeData(repoPath, "a.txt", "1");
			service.scheduleSync(target(repoPath));
			// Wait past the debounce window: paused → no commit.
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(boardCommitCount(repoPath)).toBe(before);

			// Resuming flushes the accumulated write.
			const resumed = await service.setAutoSyncPaused(target(repoPath), false);
			expect(resumed.autoSyncPaused).toBe(false);
			await waitFor(() => boardCommitCount(repoPath) === before + 1);
			await service.dispose();
		} finally {
			cleanup();
		}
	});

	it("renameBranch migrates the board branch and repoints board-ref", async () => {
		const { repoPath, cleanup } = await makeDecoupledRepo("kanban-board-rename-svc-");
		try {
			writeData(repoPath, "doc.md", "hi");
			await commitBoardWorktree(repoPath, "board: seed");

			const service = createBoardSyncService({ broadcastWorkspaceState: vi.fn(), debounceMs: 10 });
			const result = await service.renameBranch(target(repoPath), "kanban/custom");
			expect(result.ok).toBe(true);
			expect(result.status).toMatchObject({ branch: "kanban/custom" });

			// The authoritative pointer was repointed and the worktree carries the data.
			expect((await readBoardRef(repoPath))?.branch).toBe("kanban/custom");
			expect(git(getBoardWorktreePath(repoPath), ["symbolic-ref", "--short", "HEAD"])).toBe("kanban/custom");
			expect(existsSync(join(getBoardWorktreeDataHome(repoPath), "files", "doc.md"))).toBe(true);
			await service.dispose();
		} finally {
			cleanup();
		}
	});

	it("reports a degraded (error) status with a clear message while a board is adopt-pending", async () => {
		const { repoPath, cleanup } = await makeDecoupledRepo("kanban-board-degraded-");
		try {
			// Simulate the provisional state a cold clone enters when its remote is unreachable.
			writeFileSync(
				join(repoPath, ".kanban", "board-adopt-pending"),
				JSON.stringify({ branch: "kanban/board" }),
				"utf8",
			);
			// A far-future reconcile delay keeps the background adopt from firing during the test.
			const service = createBoardSyncService({
				broadcastWorkspaceState: vi.fn(),
				reconcileDelaysMs: [10 * 60 * 1000],
			});
			const status = await service.getStatus(target(repoPath));
			expect(status.decoupled).toBe(true);
			expect(status.state).toBe("error");
			expect(status.lastError).toBeTruthy();
			await service.dispose();
		} finally {
			cleanup();
		}
	});

	it("adopts the remote board in the background once origin becomes reachable", async () => {
		const { cloneA, cloneB, cleanups } = makeRemoteDecoupledClones("kanban-board-bg-adopt-");
		try {
			// cloneA publishes a real board (with data) to the shared remote.
			await writeBoardRef(cloneA, { version: 1, branch: "kanban/board" });
			await setupBoardWorktree(cloneA, "kanban/board");
			writeData(cloneA, "real.txt", "from-A");
			await commitBoardWorktree(cloneA, "board: seed");
			expect((await pushBoardWorktree(cloneA, "kanban/board")).status).toBe("pushed");

			// cloneB opens while origin is unreachable → provisional empty board + adopt-pending.
			await writeBoardRef(cloneB, { version: 1, branch: "kanban/board" });
			const origUrl = git(cloneB, ["config", "remote.origin.url"]);
			git(cloneB, ["remote", "set-url", "origin", "/nonexistent/kanban-remote.git"]);
			await setupBoardWorktree(cloneB, "kanban/board");
			expect(isBoardAdoptPending(cloneB)).toBe(true);

			const broadcast = vi.fn();
			const service = createBoardSyncService({
				broadcastWorkspaceState: broadcast,
				debounceMs: 10,
				reconcileDelaysMs: [10],
			});

			// Kick off the background reconcile loop, as the badge mount / status broadcast would.
			// (The degraded `error` status mapping is covered by the dedicated test above.)
			await service.getStatus(target(cloneB));

			// Origin returns → the next background reconcile tick adopts the real remote board.
			git(cloneB, ["remote", "set-url", "origin", origUrl]);
			await waitFor(() => !isBoardAdoptPending(cloneB), 5_000);
			await waitFor(() => broadcast.mock.calls.length > 0, 5_000);
			expect(existsSync(join(getBoardWorktreeDataHome(cloneB), "files", "real.txt"))).toBe(true);

			const synced = await service.getStatus(target(cloneB));
			expect(synced.state).toBe("synced");
			await service.dispose();
		} finally {
			for (const cleanup of cleanups) {
				cleanup();
			}
		}
	});
});
