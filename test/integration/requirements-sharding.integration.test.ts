import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeRequirementItem } from "../../src/core/api-contract";
import {
	getMachineKanbanHomePath,
	getWorkspaceDirectoryPath,
	loadWorkspaceState,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const WORKSPACE_ID = "shardrepo";

function emptyBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function requirement(id: string, order: number): RuntimeRequirementItem {
	return {
		id,
		title: `Requirement ${id}`,
		description: "",
		priority: "medium",
		status: "draft",
		linkedTaskIds: [],
		order,
		createdAt: 1,
		updatedAt: 1,
	};
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

function isIgnoredByGit(repoPath: string, relativePath: string): boolean {
	const result = spawnSync("git", ["check-ignore", relativePath], {
		cwd: repoPath,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	return result.status === 0;
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-shard-home-");
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

async function withRepo<T>(run: (repoPath: string) => Promise<T>): Promise<T> {
	return await withTemporaryHome(async () => {
		const { path: sandbox, cleanup } = createTempDir("kanban-shard-");
		try {
			const repoPath = join(sandbox, WORKSPACE_ID);
			mkdirSync(repoPath, { recursive: true });
			initGitRepository(repoPath);
			return await run(repoPath);
		} finally {
			cleanup();
		}
	});
}

describe.sequential("requirements sharding", () => {
	it("persists requirements, versions, and links as per-id shards and writes no single files", async () => {
		await withRepo(async (repoPath) => {
			const initial = await loadWorkspaceState(repoPath);
			await saveWorkspaceState(repoPath, {
				board: emptyBoard(),
				sessions: {},
				requirements: { items: [requirement("r1", 0), requirement("r2", 1)] },
				expectedRevision: initial.revision,
			});

			const workspaceDir = getWorkspaceDirectoryPath(repoPath, WORKSPACE_ID);
			expect((await readdir(join(workspaceDir, "requirements"))).sort()).toEqual(["r1.json", "r2.json"]);
			// create-versions are recorded per requirement.
			expect((await readdir(join(workspaceDir, "requirement-versions"))).sort()).toEqual(["r1.json", "r2.json"]);
			// The single-file representations are not written.
			expect(existsSync(join(workspaceDir, "requirements.json"))).toBe(false);
			expect(existsSync(join(workspaceDir, "requirement-versions.json"))).toBe(false);

			// The aggregate round-trips back through the read path.
			const reloaded = await loadWorkspaceState(repoPath);
			expect(reloaded.requirements.items.map((item) => item.id)).toEqual(["r1", "r2"]);
		});
	});

	it("migrates a legacy single requirements.json in the repo into shards and removes the single file", async () => {
		await withRepo(async (repoPath) => {
			const workspaceDir = getWorkspaceDirectoryPath(repoPath, WORKSPACE_ID);
			mkdirSync(workspaceDir, { recursive: true });
			writeFileSync(
				join(workspaceDir, "requirements.json"),
				JSON.stringify({ items: [requirement("old", 0)] }),
				"utf8",
			);

			const state = await loadWorkspaceState(repoPath);

			expect(state.requirements.items.map((item) => item.id)).toEqual(["old"]);
			expect(existsSync(join(workspaceDir, "requirements", "old.json"))).toBe(true);
			expect(existsSync(join(workspaceDir, "requirements.json"))).toBe(false);
		});
	});

	it("copy-migrates legacy ~/.kanban single-file requirements into repo shards, leaving the original intact", async () => {
		await withRepo(async (repoPath) => {
			const legacyDir = join(getMachineKanbanHomePath(), "workspaces", WORKSPACE_ID);
			mkdirSync(legacyDir, { recursive: true });
			writeFileSync(
				join(legacyDir, "requirements.json"),
				JSON.stringify({ items: [requirement("leg", 0)] }),
				"utf8",
			);

			const state = await loadWorkspaceState(repoPath);

			expect(state.requirements.items.map((item) => item.id)).toEqual(["leg"]);
			const workspaceDir = getWorkspaceDirectoryPath(repoPath, WORKSPACE_ID);
			expect(existsSync(join(workspaceDir, "requirements", "leg.json"))).toBe(true);
			// Legacy machine-home original is never moved or deleted.
			expect(existsSync(join(legacyDir, "requirements.json"))).toBe(true);
		});
	});

	it("commits requirement shard directories while keeping runtime ignored", async () => {
		await withRepo(async (repoPath) => {
			await loadWorkspaceState(repoPath);

			const base = `.kanban/workspaces/${WORKSPACE_ID}`;
			expect(isIgnoredByGit(repoPath, `${base}/requirements/r1.json`)).toBe(false);
			expect(isIgnoredByGit(repoPath, `${base}/requirement-versions/r1.json`)).toBe(false);
			expect(isIgnoredByGit(repoPath, `${base}/requirement-task-links/r1.json`)).toBe(false);
			// Runtime stays ignored.
			expect(isIgnoredByGit(repoPath, `${base}/sessions.json`)).toBe(true);
			expect(isIgnoredByGit(repoPath, `${base}/meta.json`)).toBe(true);
		});
	});
});
