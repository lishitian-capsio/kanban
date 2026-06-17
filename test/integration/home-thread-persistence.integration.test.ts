import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWorkspaceHomeThreadStore } from "../../src/session/home-thread-store";
import { loadWorkspaceContext } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-threads-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
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
		cleanup();
	}
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

describe.sequential("home chat thread persistence", () => {
	it("keeps a created thread after a simulated restart", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-home-threads-repo-");
			try {
				const workspacePath = join(sandboxRoot, "project-threads");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				// Register the workspace in the index (mirrors how the runtime resolves repoPath).
				const context = await loadWorkspaceContext(workspacePath);

				// Create a thread through the same store the tRPC endpoints use.
				const store = createWorkspaceHomeThreadStore(context.workspaceId);
				const created = await store.create({ agentId: "claude", name: "会话" });
				expect((await store.list()).map((t) => t.id)).toEqual([created.id]);

				// Simulate a Kanban restart: a brand-new store with no in-memory state,
				// reading straight from disk via the workspace index.
				const storeAfterRestart = createWorkspaceHomeThreadStore(context.workspaceId);
				const reloaded = await storeAfterRestart.list();

				expect(reloaded.map((t) => ({ id: t.id, name: t.name, agentId: t.agentId }))).toEqual([
					{ id: created.id, name: "会话", agentId: "claude" },
				]);
			} finally {
				cleanup();
			}
		});
	});
});
