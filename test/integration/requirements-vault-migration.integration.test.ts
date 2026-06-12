import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeRequirementItem, RuntimeRequirementStatus } from "../../src/core/api-contract";
import { getWorkspaceDirectoryPath, loadWorkspaceState } from "../../src/state/workspace-state";
import { VaultDocumentStore } from "../../src/vault/vault-document-store";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const WORKSPACE_ID = "vaultrepo";

function requirement(id: string, overrides: Partial<RuntimeRequirementItem> = {}): RuntimeRequirementItem {
	return {
		id,
		title: `Requirement ${id}`,
		description: "",
		priority: "medium",
		status: "draft",
		linkedTaskIds: [],
		order: 0,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function seedRequirementShard(workspaceDir: string, item: RuntimeRequirementItem): void {
	const dir = join(workspaceDir, "requirements");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${item.id}.json`), JSON.stringify(item), "utf8");
}

function seedTaskLinkShard(workspaceDir: string, requirementId: string, taskIds: string[]): void {
	const dir = join(workspaceDir, "requirement-task-links");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${requirementId}.json`),
		JSON.stringify(taskIds.map((taskId) => ({ requirementId, taskId, source: "human", createdAt: 1 }))),
		"utf8",
	);
}

function seedVersionShard(workspaceDir: string, item: RuntimeRequirementItem): void {
	const dir = join(workspaceDir, "requirement-versions");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${item.id}.json`),
		JSON.stringify([
			{ requirementId: item.id, version: 1, changeKind: "create", snapshot: item, source: "human", createdAt: 1 },
		]),
		"utf8",
	);
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-vault-migrate-home-");
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
		const { path: sandbox, cleanup } = createTempDir("kanban-vault-migrate-");
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

const docsRequirementDir = (repoPath: string): string => join(repoPath, ".kanban", "files", "docs", "requirement");

const requirementsShardDir = (workspaceDir: string): string => join(workspaceDir, "requirements");

describe.sequential("requirements vault migration", () => {
	it("migrates sharded requirements into vault docs, remapping status + links, and deletes the requirements shard dir", async () => {
		await withRepo(async (repoPath) => {
			const workspaceDir = getWorkspaceDirectoryPath(repoPath, WORKSPACE_ID);
			seedRequirementShard(workspaceDir, requirement("r1", { status: "draft", description: "Body one" }));
			seedRequirementShard(
				workspaceDir,
				requirement("r2", { status: "done", description: "Body two", linkedTaskIds: ["task-a"] }),
			);
			seedRequirementShard(workspaceDir, requirement("r3", { status: "archived" }));
			seedRequirementShard(workspaceDir, requirement("r4", { status: "active" }));
			// A task link not already mirrored into linkedTaskIds, plus version history to be retired.
			seedTaskLinkShard(workspaceDir, "r2", ["task-b"]);
			seedVersionShard(workspaceDir, requirement("r1"));

			const state = await loadWorkspaceState(repoPath);

			// One markdown document per requirement, named <slug>-<id>.md.
			const docFiles = (await readdir(docsRequirementDir(repoPath))).sort();
			expect(docFiles).toEqual([
				"requirement-r1-r1.md",
				"requirement-r2-r2.md",
				"requirement-r3-r3.md",
				"requirement-r4-r4.md",
			]);

			// Real markdown on disk: frontmatter + body, status remapped to a PROBLEM state.
			const r1Raw = await readFile(join(docsRequirementDir(repoPath), "requirement-r1-r1.md"), "utf8");
			expect(r1Raw).toContain("status: proposed");
			expect(r1Raw).toContain("Body one");

			const docs = await new VaultDocumentStore(repoPath).list("requirement");
			const byId = new Map(docs.map((doc) => [doc.id, doc]));
			expect(byId.get("r1")?.frontmatter.status).toBe("proposed"); // draft → proposed
			expect(byId.get("r2")?.frontmatter.status).toBe("clarified"); // done → clarified
			expect(byId.get("r3")?.frontmatter.status).toBe("parked"); // archived → parked
			expect(byId.get("r4")?.frontmatter.status).toBe("clarified"); // active → clarified
			expect(byId.get("r2")?.body).toBe("Body two");
			// Links (linkedTaskIds + the task-link shard) collapse into related_tasks, deduped.
			expect(byId.get("r2")?.frontmatter.related_tasks).toEqual(["task-a", "task-b"]);

			// Only the requirements shard dir is consumed. The version + task-link shards
			// are left intact for the B6 retirement (still served by the old subsystems).
			expect(existsSync(requirementsShardDir(workspaceDir))).toBe(false);
			expect(existsSync(join(workspaceDir, "requirement-versions"))).toBe(true);
			expect(existsSync(join(workspaceDir, "requirement-task-links"))).toBe(true);

			// Read-path backfill: the legacy contract still serves the requirements (no data lost).
			expect(state.requirements.items.map((item) => item.id)).toEqual(["r1", "r2", "r3", "r4"]);
			const statusById = new Map(state.requirements.items.map((item) => [item.id, item.status]));
			expect(statusById.get("r1")).toBe<RuntimeRequirementStatus>("draft");
			expect(statusById.get("r2")).toBe<RuntimeRequirementStatus>("active"); // clarified → active (lossy reverse)
			expect(statusById.get("r3")).toBe<RuntimeRequirementStatus>("archived");
			expect(state.requirements.items.find((item) => item.id === "r2")?.linkedTaskIds).toEqual(["task-a", "task-b"]);
			// Task-link read stays shard-first, so the aggregate reflects the (kept) link
			// shard only — task-a lived solely in linkedTaskIds, not as a link record.
			expect(
				state.requirementTaskLinks.links.filter((link) => link.requirementId === "r2").map((link) => link.taskId),
			).toEqual(["task-b"]);
		});
	});

	it("is idempotent — re-running the migration neither duplicates docs nor recreates the shard dirs", async () => {
		await withRepo(async (repoPath) => {
			const workspaceDir = getWorkspaceDirectoryPath(repoPath, WORKSPACE_ID);
			seedRequirementShard(workspaceDir, requirement("r1", { description: "Body one" }));
			seedRequirementShard(workspaceDir, requirement("r2", { description: "Body two" }));

			await loadWorkspaceState(repoPath);
			const firstPass = (await readdir(docsRequirementDir(repoPath))).sort();

			// The docs/requirement guard makes a second prepare a no-op.
			const reloaded = await loadWorkspaceState(repoPath);
			const secondPass = (await readdir(docsRequirementDir(repoPath))).sort();

			expect(secondPass).toEqual(firstPass);
			expect(secondPass).toHaveLength(2);
			expect(reloaded.requirements.items.map((item) => item.id)).toEqual(["r1", "r2"]);
			expect(existsSync(requirementsShardDir(workspaceDir))).toBe(false);
		});
	});

	it("migrates a legacy single-file requirements.json (sharded first) into vault docs", async () => {
		await withRepo(async (repoPath) => {
			const workspaceDir = getWorkspaceDirectoryPath(repoPath, WORKSPACE_ID);
			mkdirSync(workspaceDir, { recursive: true });
			writeFileSync(
				join(workspaceDir, "requirements.json"),
				JSON.stringify({ items: [requirement("old", { status: "draft", description: "Legacy body" })] }),
				"utf8",
			);

			const state = await loadWorkspaceState(repoPath);

			expect((await readdir(docsRequirementDir(repoPath))).sort()).toEqual(["requirement-old-old.md"]);
			const docs = await new VaultDocumentStore(repoPath).list("requirement");
			expect(docs[0]?.frontmatter.status).toBe("proposed");
			expect(docs[0]?.body).toBe("Legacy body");

			// The single file and the intermediate shard dir are both consumed.
			expect(existsSync(join(workspaceDir, "requirements.json"))).toBe(false);
			expect(existsSync(join(workspaceDir, "requirements"))).toBe(false);
			expect(state.requirements.items.map((item) => item.id)).toEqual(["old"]);
		});
	});
});
