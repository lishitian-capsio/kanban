import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGitTag, deleteGitTag } from "../../src/workspace/git-tag";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function initRepository(path: string): void {
	runGit(path, ["init", "-q"]);
	runGit(path, ["config", "user.name", "Test User"]);
	runGit(path, ["config", "user.email", "test@example.com"]);
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

describe.sequential("git tag runtime", () => {
	it("creates an annotated tag at HEAD when given a message", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-tag-annotated-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "hello\n", "utf8");
			const head = commitAll(repoPath, "init");

			const response = await createGitTag({ cwd: repoPath, name: "v1.0.0", message: "release 1.0.0" });

			expect(response).toEqual({ ok: true, name: "v1.0.0" });
			expect(runGit(repoPath, ["cat-file", "-t", "v1.0.0"])).toBe("tag");
			expect(runGit(repoPath, ["rev-parse", "v1.0.0^{commit}"])).toBe(head);
			expect(runGit(repoPath, ["tag", "-l", "--format=%(contents:subject)", "v1.0.0"])).toBe("release 1.0.0");
		} finally {
			cleanup();
		}
	});

	it("creates a lightweight tag when no message is given", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-tag-lightweight-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "hello\n", "utf8");
			commitAll(repoPath, "init");

			const response = await createGitTag({ cwd: repoPath, name: "light" });

			expect(response.ok).toBe(true);
			expect(runGit(repoPath, ["cat-file", "-t", "light"])).toBe("commit");
		} finally {
			cleanup();
		}
	});

	it("creates a tag at an explicit commitish", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-tag-commitish-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "one\n", "utf8");
			const first = commitAll(repoPath, "first");
			writeFileSync(join(repoPath, "b.txt"), "two\n", "utf8");
			commitAll(repoPath, "second");

			const response = await createGitTag({ cwd: repoPath, name: "at-first", commitish: first });

			expect(response.ok).toBe(true);
			expect(runGit(repoPath, ["rev-parse", "at-first^{commit}"])).toBe(first);
		} finally {
			cleanup();
		}
	});

	it("rejects an invalid tag name without running git tag", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-tag-invalid-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "hello\n", "utf8");
			commitAll(repoPath, "init");

			const response = await createGitTag({ cwd: repoPath, name: "bad name~with^spaces" });

			expect(response.ok).toBe(false);
			expect(response.error).toBeTruthy();
			expect(runGit(repoPath, ["tag", "-l"])).toBe("");
		} finally {
			cleanup();
		}
	});

	it("rejects a tag name that starts with a dash", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-tag-dash-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "hello\n", "utf8");
			commitAll(repoPath, "init");

			const response = await createGitTag({ cwd: repoPath, name: "-rf" });

			expect(response.ok).toBe(false);
			expect(runGit(repoPath, ["tag", "-l"])).toBe("");
		} finally {
			cleanup();
		}
	});

	it("fails cleanly when the target commitish does not exist", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-tag-missing-target-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "hello\n", "utf8");
			commitAll(repoPath, "init");

			const response = await createGitTag({ cwd: repoPath, name: "v9", commitish: "does-not-exist" });

			expect(response.ok).toBe(false);
			expect(runGit(repoPath, ["tag", "-l"])).toBe("");
		} finally {
			cleanup();
		}
	});

	it("deletes an existing tag locally", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-tag-delete-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "hello\n", "utf8");
			commitAll(repoPath, "init");
			runGit(repoPath, ["tag", "to-delete"]);

			const response = await deleteGitTag({ cwd: repoPath, name: "to-delete" });

			expect(response).toEqual({ ok: true, name: "to-delete" });
			expect(runGit(repoPath, ["tag", "-l"])).toBe("");
		} finally {
			cleanup();
		}
	});

	it("fails to delete a tag that does not exist", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-git-tag-delete-missing-");
		try {
			initRepository(repoPath);
			writeFileSync(join(repoPath, "a.txt"), "hello\n", "utf8");
			commitAll(repoPath, "init");

			const response = await deleteGitTag({ cwd: repoPath, name: "ghost" });

			expect(response.ok).toBe(false);
			expect(response.error).toBeTruthy();
		} finally {
			cleanup();
		}
	});
});
