import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	detectGitRepositoryInfo,
	getGitRepositoryInfoReadCountForTests,
	invalidateGitRepositoryInfoCache,
	resetGitRepositoryInfoCacheForTests,
	setGitRepositoryInfoClockForTests,
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

afterEach(() => {
	resetGitRepositoryInfoCacheForTests();
});

describe("detectGitRepositoryInfo TTL cache", () => {
	it("detects only once within the TTL window", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-info-ttl-");
		try {
			initRepository(repoPath);
			resetGitRepositoryInfoCacheForTests();
			setGitRepositoryInfoClockForTests(() => 1_000);

			const before = getGitRepositoryInfoReadCountForTests();
			const first = await detectGitRepositoryInfo(repoPath);
			setGitRepositoryInfoClockForTests(() => 2_000); // still inside the TTL
			const second = await detectGitRepositoryInfo(repoPath);

			expect(getGitRepositoryInfoReadCountForTests() - before).toBe(1);
			expect(second).toEqual(first);
			expect(first.currentBranch).toBe("main");
		} finally {
			cleanup();
		}
	});

	it("re-detects after the TTL expires", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-info-ttl-expire-");
		try {
			initRepository(repoPath);
			resetGitRepositoryInfoCacheForTests();
			setGitRepositoryInfoClockForTests(() => 1_000);

			const before = getGitRepositoryInfoReadCountForTests();
			await detectGitRepositoryInfo(repoPath);
			setGitRepositoryInfoClockForTests(() => 1_000 + 10_000); // well past the TTL
			await detectGitRepositoryInfo(repoPath);

			expect(getGitRepositoryInfoReadCountForTests() - before).toBe(2);
		} finally {
			cleanup();
		}
	});

	it("re-detects immediately after invalidation (in-app checkout path)", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-info-invalidate-");
		try {
			initRepository(repoPath);
			resetGitRepositoryInfoCacheForTests();
			setGitRepositoryInfoClockForTests(() => 1_000);

			await detectGitRepositoryInfo(repoPath);
			const before = getGitRepositoryInfoReadCountForTests();
			invalidateGitRepositoryInfoCache(repoPath);
			await detectGitRepositoryInfo(repoPath); // same clock, but cache was busted
			expect(getGitRepositoryInfoReadCountForTests() - before).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("dedups concurrent detections into a single read", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-info-concurrent-");
		try {
			initRepository(repoPath);
			resetGitRepositoryInfoCacheForTests();
			setGitRepositoryInfoClockForTests(() => 1_000);

			const before = getGitRepositoryInfoReadCountForTests();
			await Promise.all([detectGitRepositoryInfo(repoPath), detectGitRepositoryInfo(repoPath)]);
			expect(getGitRepositoryInfoReadCountForTests() - before).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("does not cache a failed detection (non-git directory)", async () => {
		const { path: nonRepo, cleanup } = createTempDir("kanban-git-info-nonrepo-");
		try {
			resetGitRepositoryInfoCacheForTests();
			setGitRepositoryInfoClockForTests(() => 1_000);

			const before = getGitRepositoryInfoReadCountForTests();
			await expect(detectGitRepositoryInfo(nonRepo)).rejects.toThrow();
			await expect(detectGitRepositoryInfo(nonRepo)).rejects.toThrow();
			// A rejected detection must not be served from cache.
			expect(getGitRepositoryInfoReadCountForTests() - before).toBe(2);
		} finally {
			cleanup();
		}
	});
});
