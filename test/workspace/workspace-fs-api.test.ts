import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fsCreateEntry,
	fsDeleteEntry,
	fsListDir,
	fsMove,
	fsReadFile,
	fsRename,
	fsStat,
} from "../../src/workspace/workspace-fs-api";
import { createTempDir } from "../utilities/temp-dir";

function initGitRepo(root: string): void {
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
}

describe("workspace-fs-api", () => {
	let repo: { path: string; cleanup: () => void };
	let outside: { path: string; cleanup: () => void };

	beforeEach(() => {
		repo = createTempDir("kanban-fs-repo-");
		outside = createTempDir("kanban-fs-outside-");
		initGitRepo(repo.path);
		// A representative working tree.
		writeFileSync(join(repo.path, "readme.md"), "# hello\n");
		writeFileSync(join(repo.path, "app.ts"), "export const x = 1;\n");
		writeFileSync(join(repo.path, ".gitignore"), "ignored.log\nnode_modules/\n");
		writeFileSync(join(repo.path, "ignored.log"), "secret\n");
		mkdirSync(join(repo.path, "src"));
		writeFileSync(join(repo.path, "src", "index.ts"), "console.log(1);\n");
		mkdirSync(join(repo.path, "node_modules"));
		writeFileSync(join(repo.path, "node_modules", "pkg.js"), "module.exports = {};\n");
		// Engine/runtime dirs that must always be hidden.
		mkdirSync(join(repo.path, ".kanban"));
		writeFileSync(join(repo.path, ".kanban", "meta.json"), "{}\n");
	});

	afterEach(() => {
		repo.cleanup();
		outside.cleanup();
	});

	describe("listDir", () => {
		it("lists the repo root and always hides .git and .kanban", async () => {
			const result = await fsListDir(repo.path, {});
			expect(result.ok).toBe(true);
			expect(result.isGitRepository).toBe(true);
			const names = result.entries.map((entry) => entry.name);
			expect(names).not.toContain(".git");
			expect(names).not.toContain(".kanban");
			expect(names).toContain("readme.md");
			expect(names).toContain("src");
			// Directories sort before files.
			expect(result.entries[0]?.kind).toBe("dir");
		});

		it("hides gitignored entries by default and reveals them with showHidden (flagged)", async () => {
			const hidden = await fsListDir(repo.path, {});
			expect(hidden.entries.map((entry) => entry.name)).not.toContain("ignored.log");
			expect(hidden.entries.map((entry) => entry.name)).not.toContain("node_modules");

			const shown = await fsListDir(repo.path, { showHidden: true });
			const ignoredEntry = shown.entries.find((entry) => entry.name === "ignored.log");
			expect(ignoredEntry).toBeDefined();
			expect(ignoredEntry?.gitIgnored).toBe(true);
			// A non-ignored file is not flagged.
			expect(shown.entries.find((entry) => entry.name === "readme.md")?.gitIgnored).toBe(false);
		});

		it("rejects a `..` traversal path", async () => {
			const result = await fsListDir(repo.path, { path: "../" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/outside/i);
		});

		it("rejects an absolute path", async () => {
			const result = await fsListDir(repo.path, { path: outside.path });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/outside/i);
		});

		it("marks a symlink but does not follow one escaping the root", async () => {
			symlinkSync(outside.path, join(repo.path, "escape-link"));
			const result = await fsListDir(repo.path, { showHidden: true });
			const link = result.entries.find((entry) => entry.name === "escape-link");
			expect(link).toBeDefined();
			expect(link?.isSymlink).toBe(true);
			// Not followed to a directory outside the root.
			expect(link?.kind).toBe("file");
		});

		it("degrades to a non-git listing (dotfiles hidden by default) outside a repo", async () => {
			const plain = createTempDir("kanban-fs-plain-");
			try {
				writeFileSync(join(plain.path, "keep.txt"), "hi\n");
				writeFileSync(join(plain.path, ".env"), "SECRET=1\n");
				const hidden = await fsListDir(plain.path, {});
				expect(hidden.isGitRepository).toBe(false);
				expect(hidden.entries.map((entry) => entry.name)).toContain("keep.txt");
				expect(hidden.entries.map((entry) => entry.name)).not.toContain(".env");
				const shown = await fsListDir(plain.path, { showHidden: true });
				expect(shown.entries.map((entry) => entry.name)).toContain(".env");
			} finally {
				plain.cleanup();
			}
		});
	});

	describe("readFile", () => {
		it("reads a text file as utf8 with mtime", async () => {
			const result = await fsReadFile(repo.path, { path: "app.ts" });
			expect(result.ok).toBe(true);
			expect(result.binary).toBe(false);
			expect(result.encoding).toBe("utf8");
			expect(result.content).toBe("export const x = 1;\n");
			expect(result.mtimeMs).toBeGreaterThan(0);
			expect(result.tooLarge).toBe(false);
		});

		it("reads a binary file as base64", async () => {
			// PNG signature + a NUL byte make this unambiguously binary.
			const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
			writeFileSync(join(repo.path, "pixel.png"), bytes);
			const result = await fsReadFile(repo.path, { path: "pixel.png" });
			expect(result.ok).toBe(true);
			expect(result.binary).toBe(true);
			expect(result.encoding).toBe("base64");
			expect(result.content).toBe(bytes.toString("base64"));
		});

		it("withholds content for an oversized text file (tooLarge)", async () => {
			const big = "a".repeat(1024 * 1024 + 10);
			writeFileSync(join(repo.path, "big.txt"), big);
			const result = await fsReadFile(repo.path, { path: "big.txt" });
			expect(result.ok).toBe(true);
			expect(result.tooLarge).toBe(true);
			expect(result.content).toBeUndefined();
			expect(result.size).toBeGreaterThan(1024 * 1024);
		});

		it("rejects reading through a `..` escape", async () => {
			const result = await fsReadFile(repo.path, { path: "../secret.txt" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/outside/i);
		});

		it("rejects reading a symlink that targets outside the root", async () => {
			writeFileSync(join(outside.path, "secret.txt"), "leak\n");
			symlinkSync(join(outside.path, "secret.txt"), join(repo.path, "leak-link"));
			const result = await fsReadFile(repo.path, { path: "leak-link" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/outside/i);
		});

		it("errors when the path is a directory", async () => {
			const result = await fsReadFile(repo.path, { path: "src" });
			expect(result.ok).toBe(false);
		});
	});

	describe("stat", () => {
		it("returns an entry for an existing file with the gitIgnored flag", async () => {
			const result = await fsStat(repo.path, { path: "ignored.log" });
			expect(result.ok).toBe(true);
			expect(result.entry?.name).toBe("ignored.log");
			expect(result.entry?.gitIgnored).toBe(true);
		});

		it("returns a null entry for a missing path", async () => {
			const result = await fsStat(repo.path, { path: "does-not-exist.txt" });
			expect(result.ok).toBe(true);
			expect(result.entry).toBeNull();
		});

		it("rejects an out-of-root path", async () => {
			const result = await fsStat(repo.path, { path: "../../etc/passwd" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/outside/i);
		});
	});

	describe("createEntry", () => {
		it("creates an empty file and returns its entry", async () => {
			const result = await fsCreateEntry(repo.path, { path: "src/new.ts", kind: "file" });
			expect(result.ok).toBe(true);
			expect(result.entry?.kind).toBe("file");
			expect(result.entry?.path).toBe("src/new.ts");
			expect(readFileSync(join(repo.path, "src", "new.ts"), "utf8")).toBe("");
		});

		it("creates a directory", async () => {
			const result = await fsCreateEntry(repo.path, { path: "src/nested", kind: "dir" });
			expect(result.ok).toBe(true);
			expect(result.entry?.kind).toBe("dir");
			expect(existsSync(join(repo.path, "src", "nested"))).toBe(true);
		});

		it("refuses to overwrite an existing entry", async () => {
			const result = await fsCreateEntry(repo.path, { path: "app.ts", kind: "file" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/exist/i);
			// The original content is untouched.
			expect(readFileSync(join(repo.path, "app.ts"), "utf8")).toBe("export const x = 1;\n");
		});

		it("fails when the parent directory does not exist", async () => {
			const result = await fsCreateEntry(repo.path, { path: "no-such-dir/file.ts", kind: "file" });
			expect(result.ok).toBe(false);
		});

		it("rejects a `..` escape", async () => {
			const result = await fsCreateEntry(repo.path, { path: "../evil.ts", kind: "file" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/outside/i);
			expect(existsSync(join(outside.path, "..", "evil.ts"))).toBe(false);
		});

		it("refuses to create inside .kanban", async () => {
			const result = await fsCreateEntry(repo.path, { path: ".kanban/evil.json", kind: "file" });
			expect(result.ok).toBe(false);
			expect(existsSync(join(repo.path, ".kanban", "evil.json"))).toBe(false);
		});
	});

	describe("rename", () => {
		it("renames a file within its directory", async () => {
			const result = await fsRename(repo.path, { path: "src/index.ts", newName: "main.ts" });
			expect(result.ok).toBe(true);
			expect(result.entry?.path).toBe("src/main.ts");
			expect(existsSync(join(repo.path, "src", "index.ts"))).toBe(false);
			expect(existsSync(join(repo.path, "src", "main.ts"))).toBe(true);
		});

		it("rejects a newName containing a path separator", async () => {
			const result = await fsRename(repo.path, { path: "app.ts", newName: "../app.ts" });
			expect(result.ok).toBe(false);
			expect(existsSync(join(repo.path, "app.ts"))).toBe(true);
		});

		it("rejects renaming onto an existing name", async () => {
			const result = await fsRename(repo.path, { path: "src/index.ts", newName: "index.ts" });
			expect(result.ok).toBe(false);
		});

		it("rejects an out-of-root source", async () => {
			const result = await fsRename(repo.path, { path: "../secret.txt", newName: "x.txt" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/outside/i);
		});
	});

	describe("move", () => {
		it("moves a file into another directory", async () => {
			const result = await fsMove(repo.path, { fromPath: "app.ts", toPath: "src/app.ts" });
			expect(result.ok).toBe(true);
			expect(result.entry?.path).toBe("src/app.ts");
			expect(existsSync(join(repo.path, "app.ts"))).toBe(false);
			expect(readFileSync(join(repo.path, "src", "app.ts"), "utf8")).toBe("export const x = 1;\n");
		});

		it("rejects when the destination already exists", async () => {
			const result = await fsMove(repo.path, { fromPath: "app.ts", toPath: "src/index.ts" });
			expect(result.ok).toBe(false);
			expect(existsSync(join(repo.path, "app.ts"))).toBe(true);
		});

		it("refuses to move a directory into its own descendant", async () => {
			mkdirSync(join(repo.path, "src", "deep"));
			const result = await fsMove(repo.path, { fromPath: "src", toPath: "src/deep/src" });
			expect(result.ok).toBe(false);
		});

		it("rejects an out-of-root destination", async () => {
			const result = await fsMove(repo.path, { fromPath: "app.ts", toPath: "../app.ts" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/outside/i);
			expect(existsSync(join(repo.path, "app.ts"))).toBe(true);
		});
	});

	describe("deleteEntry", () => {
		it("deletes a file", async () => {
			const result = await fsDeleteEntry(repo.path, { path: "app.ts" });
			expect(result.ok).toBe(true);
			expect(existsSync(join(repo.path, "app.ts"))).toBe(false);
		});

		it("refuses a non-empty directory without recursive", async () => {
			const result = await fsDeleteEntry(repo.path, { path: "src" });
			expect(result.ok).toBe(false);
			expect(existsSync(join(repo.path, "src"))).toBe(true);
		});

		it("deletes a non-empty directory with recursive", async () => {
			const result = await fsDeleteEntry(repo.path, { path: "src", recursive: true });
			expect(result.ok).toBe(true);
			expect(existsSync(join(repo.path, "src"))).toBe(false);
		});

		it("refuses to delete the repository root", async () => {
			const result = await fsDeleteEntry(repo.path, { path: "" });
			expect(result.ok).toBe(false);
			expect(existsSync(repo.path)).toBe(true);
		});

		it("rejects a `..` escape", async () => {
			writeFileSync(join(outside.path, "keep.txt"), "keep\n");
			const result = await fsDeleteEntry(repo.path, { path: "../keep.txt" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/outside/i);
			expect(existsSync(join(outside.path, "keep.txt"))).toBe(true);
		});

		it("refuses to delete .kanban", async () => {
			const result = await fsDeleteEntry(repo.path, { path: ".kanban" });
			expect(result.ok).toBe(false);
			expect(existsSync(join(repo.path, ".kanban"))).toBe(true);
		});
	});
});
