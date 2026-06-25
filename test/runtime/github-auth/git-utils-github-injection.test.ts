import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGit, setGitHubGitAuthInjector } from "../../../src/workspace/git-utils";
import { createTempDir } from "../../utilities/temp-dir";

const MARKER = "KANBAN_TEST_GH_HELPER_MARKER";

describe("runGit github credential injection seam", () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(async () => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		await runGit(dir, ["init", "-q", "."]);
	});
	afterEach(() => {
		setGitHubGitAuthInjector(null);
		cleanup();
	});

	it("prepends the injector's config args to the git invocation", async () => {
		setGitHubGitAuthInjector(async () => ({
			args: ["-c", `credential.https://github.com.helper=!echo ${MARKER}`],
			env: { KANBAN_GIT_GITHUB_TOKEN: "tok" },
		}));
		const result = await runGit(dir, ["config", "--list"]);
		expect(result.ok).toBe(true);
		expect(result.stdout).toContain(MARKER);
	});

	it("injects nothing when no injector is registered (passthrough)", async () => {
		setGitHubGitAuthInjector(null);
		const result = await runGit(dir, ["config", "--list"]);
		expect(result.stdout).not.toContain(MARKER);
	});

	it("injects nothing when the injector returns null (logged out)", async () => {
		setGitHubGitAuthInjector(async () => null);
		const result = await runGit(dir, ["config", "--list"]);
		expect(result.stdout).not.toContain(MARKER);
	});

	it("never breaks the git op when the injector throws", async () => {
		setGitHubGitAuthInjector(async () => {
			throw new Error("injector boom");
		});
		const result = await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("true");
	});

	it("merges the injector env into the spawn (does not clobber the base env)", async () => {
		// Sanity: a normal local op still succeeds with an injector that supplies env.
		setGitHubGitAuthInjector(async () => ({ args: [], env: { KANBAN_GIT_GITHUB_TOKEN: "tok" } }));
		const result = await runGit(dir, ["rev-parse", "--git-dir"]);
		expect(result.ok).toBe(true);
		expect(result.stdout).toContain(join(".git"));
	});
});
