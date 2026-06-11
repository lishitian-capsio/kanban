import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	getRuntimeHomePath,
	getTaskWorktreesHomePath,
	getWorkspaceDirectoryPath,
	getWorkspaceSessionMessagesDirPath,
	getWorkspacesRootPath,
} from "../../../src/state/workspace-state";

describe("runtime home paths", () => {
	const repo = "/tmp/example-repo";

	it("roots per-workspace data at <repoPath>/.kanban", () => {
		expect(getRuntimeHomePath(repo)).toBe(join(repo, ".kanban"));
		expect(getTaskWorktreesHomePath(repo)).toBe(join(repo, ".kanban", "worktrees"));
		expect(getWorkspacesRootPath(repo)).toBe(join(repo, ".kanban", "workspaces"));
		expect(getWorkspaceDirectoryPath(repo, "proj")).toBe(join(repo, ".kanban", "workspaces", "proj"));
		expect(getWorkspaceSessionMessagesDirPath(repo, "proj")).toBe(
			join(repo, ".kanban", "workspaces", "proj", "sessions"),
		);
	});

	it("does not root per-workspace data under the home directory", () => {
		expect(getRuntimeHomePath(repo).startsWith(homedir())).toBe(false);
	});
});
