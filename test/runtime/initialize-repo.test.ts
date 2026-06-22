import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureDefaultGitignore } from "../../src/workspace/initialize-repo";
import { createTempDir } from "../utilities/temp-dir";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const { path, cleanup } = createTempDir("init-repo-");
	try {
		return await run(path);
	} finally {
		cleanup();
	}
}

describe("ensureDefaultGitignore", () => {
	it("writes a default .gitignore that excludes heavy dependency/build dirs when none exists", async () => {
		await withTempDir(async (dir) => {
			const created = await ensureDefaultGitignore(dir);

			expect(created).toBe(true);
			const content = await readFile(join(dir, ".gitignore"), "utf8");
			// The directories that make a freshly-`init`'d project "体积很大" and that
			// `git add -A` must not stage / hash / duplicate into .git.
			expect(content).toMatch(/^node_modules\/$/m);
			expect(content).toMatch(/^dist\/$/m);
			expect(content).toMatch(/^build\/$/m);
		});
	});

	it("never overwrites an existing .gitignore", async () => {
		await withTempDir(async (dir) => {
			const existing = "# my rules\nsecrets.env\n";
			await writeFile(join(dir, ".gitignore"), existing, "utf8");

			const created = await ensureDefaultGitignore(dir);

			expect(created).toBe(false);
			expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(existing);
		});
	});
});
