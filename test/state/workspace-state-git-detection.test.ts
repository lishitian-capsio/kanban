import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectGitRepositoryInfo, invalidateGitRepositoryInfoCache } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
}

function initRepository(path: string): void {
	runGit(path, ["init", "-q", "-b", "main"]);
	runGit(path, ["config", "user.name", "Test User"]);
	runGit(path, ["config", "user.email", "test@example.com"]);
	writeFileSync(join(path, "file.txt"), "hello\n", "utf8");
	runGit(path, ["add", "."]);
	runGit(path, ["commit", "-qm", "init"]);
	runGit(path, ["branch", "feature/x"]);
}

describe("detectGitRepositoryInfo", () => {
	it("reads branch info from a real repository", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-detect-");
		try {
			initRepository(repoPath);
			const info = await detectGitRepositoryInfo(repoPath);
			expect(info.currentBranch).toBe("main");
			expect(info.branches).toContain("main");
			expect(info.branches).toContain("feature/x");
			expect(info.defaultBranch).toBe("main");
		} finally {
			cleanup();
		}
	});

	// Regression for the P0 hard hang: detectGitRepositoryInfo runs on the hot
	// loadWorkspaceContext path (every workspace-state broadcast + restart-connect).
	// It used to shell out with synchronous spawnSync, which blocks the entire event
	// loop for the git subprocess's full duration — a slow/contended git (the watchdog
	// caught an 88s freeze) hard-froze the runtime. The git reads must run across an
	// async boundary so the loop keeps breathing.
	it("does not block the event loop while git runs (no synchronous spawn)", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-detect-async-");
		try {
			initRepository(repoPath);
			const order: string[] = [];
			const detection = detectGitRepositoryInfo(repoPath).then(() => {
				order.push("git");
			});
			// A microtask queued immediately after the call must settle before the git
			// subprocess completes — only possible if the git call yields at an `await`.
			// A synchronous spawnSync would run the whole detection to completion first,
			// putting "git" before "microtask".
			await Promise.resolve();
			order.push("microtask");
			await detection;
			expect(order[0]).toBe("microtask");
		} finally {
			cleanup();
		}
	});

	// Finding T3: detectGitRepositoryInfo runs on every workspace_state_updated
	// broadcast and spawns ~4 git subprocesses. A short-TTL, single-flight memo
	// collapses the N-sessions-finish-together burst onto one detection.
	it("memoizes within the TTL and re-probes after explicit invalidation", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-detect-cache-");
		try {
			invalidateGitRepositoryInfoCache(repoPath);
			initRepository(repoPath);

			const first = await detectGitRepositoryInfo(repoPath);
			expect(first.branches).toContain("feature/x");
			expect(first.branches).not.toContain("feature/y");

			// Create a branch the cached entry can't know about.
			runGit(repoPath, ["branch", "feature/y"]);

			// Within the TTL the memo is reused, so the new branch is not yet visible.
			const cached = await detectGitRepositoryInfo(repoPath);
			expect(cached.branches).not.toContain("feature/y");

			// Eager invalidation (what a checkout triggers) forces a fresh probe.
			invalidateGitRepositoryInfoCache(repoPath);
			const refreshed = await detectGitRepositoryInfo(repoPath);
			expect(refreshed.branches).toContain("feature/y");
		} finally {
			invalidateGitRepositoryInfoCache(repoPath);
			cleanup();
		}
	});

	it("returns a defensive copy so callers cannot corrupt the shared cache entry", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-detect-clone-");
		try {
			invalidateGitRepositoryInfoCache(repoPath);
			initRepository(repoPath);

			const first = await detectGitRepositoryInfo(repoPath);
			first.branches.push("mutant/branch");

			const second = await detectGitRepositoryInfo(repoPath);
			expect(second.branches).not.toContain("mutant/branch");
		} finally {
			invalidateGitRepositoryInfoCache(repoPath);
			cleanup();
		}
	});
});
