import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isGitRepository } from "../../src/state/git-repository-check";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function initRepository(path: string): void {
	const result = spawnSync("git", ["init", "-q", "-b", "main"], {
		cwd: path,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || "git init failed");
	}
}

describe("isGitRepository", () => {
	it("returns true inside a real git work tree", async () => {
		const { path, cleanup } = createTempDir("kanban-is-git-true-");
		try {
			initRepository(path);
			expect(await isGitRepository(path)).toBe(true);
			// also true from a nested subdirectory of the work tree
			const nested = join(path, "src");
			spawnSync("mkdir", ["-p", nested]);
			expect(await isGitRepository(nested)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("returns false for a directory that is not a git repository", async () => {
		const { path, cleanup } = createTempDir("kanban-is-git-false-");
		try {
			expect(await isGitRepository(path)).toBe(false);
		} finally {
			cleanup();
		}
	});

	// Regression for the addProject hot-path freeze (the last sync git landmine):
	// the probe used spawnSync, which blocks the whole event loop for the git
	// subprocess's full duration. It must yield at an await so a wedged git degrades
	// to laggy, not frozen.
	it("does not block the event loop while git runs", async () => {
		const { path, cleanup } = createTempDir("kanban-is-git-async-");
		try {
			initRepository(path);
			const order: string[] = [];
			const probe = isGitRepository(path).then(() => {
				order.push("git");
			});
			await Promise.resolve();
			order.push("microtask");
			await probe;
			expect(order[0]).toBe("microtask");
		} finally {
			cleanup();
		}
	});
});
