import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeConfigState } from "../../src/config/runtime-config";
import { createWorkspaceRegistry } from "../../src/server/workspace-registry";
import {
	getWorkspaceBoardReadCountForTests,
	loadWorkspaceContext,
	resetWorkspaceBoardCacheForTests,
	resetWorkspaceIndexCacheForTests,
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

function createRuntimeConfigState(): RuntimeConfigState {
	return {
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		proxyEnabled: false,
		proxyHost: "",
		proxyPort: "",
		proxyUsername: "",
		proxyPassword: "",
		noProxy: "",
	};
}

let cleanups: Array<() => void> = [];
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
	const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-projects-fast-home-");
	cleanups.push(cleanupHome);
	previousHome = process.env.HOME;
	previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	resetWorkspaceIndexCacheForTests();
	resetWorkspaceBoardCacheForTests();
});

afterEach(() => {
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
	resetWorkspaceBoardCacheForTests();
	for (const cleanup of cleanups.reverse()) {
		cleanup();
	}
	cleanups = [];
});

async function setupTwoProjectRegistry() {
	const { path: repo1, cleanup: cleanupRepo1 } = createTempDir("kanban-projects-fast-repo1-");
	const { path: repo2, cleanup: cleanupRepo2 } = createTempDir("kanban-projects-fast-repo2-");
	cleanups.push(cleanupRepo1, cleanupRepo2);
	initRepository(repo1);
	initRepository(repo2);
	// Register both repos in the workspace index.
	const ctx1 = await loadWorkspaceContext(repo1);
	const ctx2 = await loadWorkspaceContext(repo2);
	const registry = await createWorkspaceRegistry({
		cwd: ctx1.repoPath,
		loadGlobalRuntimeConfig: async () => createRuntimeConfigState(),
		loadRuntimeConfig: async () => createRuntimeConfigState(),
		hasGitRepository: async () => true,
		pathIsDirectory: async () => true,
	});
	return { registry, ctx1, ctx2 };
}

describe("buildProjectsPayloadFast (F-CONN-2 connect critical path)", () => {
	it("reads only the current project's board, while buildProjectsPayload reads every project's", async () => {
		const { registry, ctx1, ctx2 } = await setupTwoProjectRegistry();

		// Cold cache: the fast path must touch exactly one board (the current project).
		resetWorkspaceBoardCacheForTests();
		const beforeFast = getWorkspaceBoardReadCountForTests();
		const fast = await registry.buildProjectsPayloadFast(ctx1.workspaceId);
		const fastReads = getWorkspaceBoardReadCountForTests() - beforeFast;
		expect(fastReads).toBe(1);
		expect(fast.currentProjectId).toBe(ctx1.workspaceId);
		expect(fast.projects.map((project) => project.id).sort()).toEqual([ctx1.workspaceId, ctx2.workspaceId].sort());

		// The full builder fans out to both projects' boards.
		resetWorkspaceBoardCacheForTests();
		const beforeFull = getWorkspaceBoardReadCountForTests();
		await registry.buildProjectsPayload(ctx1.workspaceId);
		const fullReads = getWorkspaceBoardReadCountForTests() - beforeFull;
		expect(fullReads).toBe(2);
	});

	it("primes the cache so a subsequent fast build reuses the prior full counts for non-current projects", async () => {
		const { registry, ctx1 } = await setupTwoProjectRegistry();

		// A full build populates the per-workspace counts cache for every project.
		await registry.buildProjectsPayload(ctx1.workspaceId);

		// Now a fast build for project 1 must NOT read project 2's board again — it
		// reuses the cached counts. Only the current project is read.
		resetWorkspaceBoardCacheForTests();
		const before = getWorkspaceBoardReadCountForTests();
		const fast = await registry.buildProjectsPayloadFast(ctx1.workspaceId);
		expect(getWorkspaceBoardReadCountForTests() - before).toBe(1);
		expect(fast.projects).toHaveLength(2);
	});
});
