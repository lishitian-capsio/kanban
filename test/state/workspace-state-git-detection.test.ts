import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectGitRepositoryInfo } from "../../src/state/workspace-state";
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
});
