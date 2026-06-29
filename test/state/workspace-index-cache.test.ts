import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	getMachineKanbanHomePath,
	getWorkspaceIndexParseCountForTests,
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
	removeWorkspaceIndexEntry,
	resetWorkspaceIndexCacheForTests,
	resolveRepoPathForWorkspaceId,
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

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-index-cache-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	resetWorkspaceIndexCacheForTests();
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
		resetWorkspaceIndexCacheForTests();
		cleanup();
	}
}

describe("workspace index in-process cache", () => {
	it("parses index.json only once across repeated unchanged reads", async () => {
		await withTemporaryHome(async () => {
			const { path: repoPath, cleanup } = createTempDir("kanban-index-cache-repo-");
			try {
				initRepository(repoPath);
				await loadWorkspaceContext(repoPath); // seeds + writes the index (invalidates cache)

				const before = getWorkspaceIndexParseCountForTests();
				await listWorkspaceIndexEntries();
				await listWorkspaceIndexEntries();
				await resolveRepoPathForWorkspaceId("anything");
				const after = getWorkspaceIndexParseCountForTests();

				// First read after the write re-parses once; the next two are served
				// from the in-process cache without re-reading/re-validating.
				expect(after - before).toBe(1);
			} finally {
				cleanup();
			}
		});
	});

	it("re-reads when index.json changes on disk (stat-signature invalidation)", async () => {
		await withTemporaryHome(async () => {
			const { path: repoPath, cleanup } = createTempDir("kanban-index-cache-repo-");
			try {
				initRepository(repoPath);
				const context = await loadWorkspaceContext(repoPath);

				const first = await listWorkspaceIndexEntries();
				expect(first).toHaveLength(1);

				// Simulate an out-of-band write (e.g. another kanban process) by
				// rewriting index.json with an extra entry.
				const indexPath = join(getMachineKanbanHomePath(), "workspaces", "index.json");
				mkdirSync(join(getMachineKanbanHomePath(), "workspaces"), { recursive: true });
				writeFileSync(
					indexPath,
					JSON.stringify({
						version: 1,
						entries: {
							[context.workspaceId]: { workspaceId: context.workspaceId, repoPath },
							"extra-workspace": { workspaceId: "extra-workspace", repoPath: "/tmp/extra-out-of-band-repo" },
						},
						repoPathToId: {
							[repoPath]: context.workspaceId,
							"/tmp/extra-out-of-band-repo": "extra-workspace",
						},
					}),
					"utf8",
				);

				const second = await listWorkspaceIndexEntries();
				expect(second.map((entry) => entry.workspaceId)).toContain("extra-workspace");
			} finally {
				cleanup();
			}
		});
	});

	it("reflects removeWorkspaceIndexEntry without a stale cached read", async () => {
		await withTemporaryHome(async () => {
			const { path: repoPath, cleanup } = createTempDir("kanban-index-cache-repo-");
			try {
				initRepository(repoPath);
				const context = await loadWorkspaceContext(repoPath);
				await listWorkspaceIndexEntries(); // warm the cache

				const removed = await removeWorkspaceIndexEntry(context.workspaceId);
				expect(removed).toBe(true);

				const entries = await listWorkspaceIndexEntries();
				expect(entries).toHaveLength(0);
				expect(await resolveRepoPathForWorkspaceId(context.workspaceId)).toBeNull();
			} finally {
				cleanup();
			}
		});
	});
});
