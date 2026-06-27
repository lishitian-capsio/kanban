import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGitCredentialInjector, runGit } from "../../../src/workspace/git-utils";
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
		registerGitCredentialInjector("github", null);
		cleanup();
	});

	it("prepends the injector's config args to the git invocation", async () => {
		registerGitCredentialInjector("github", async () => ({
			args: ["-c", `credential.https://github.com.helper=!echo ${MARKER}`],
			env: { KANBAN_GIT_GITHUB_TOKEN: "tok" },
		}));
		const result = await runGit(dir, ["config", "--list"]);
		expect(result.ok).toBe(true);
		expect(result.stdout).toContain(MARKER);
	});

	it("injects nothing when no injector is registered (passthrough)", async () => {
		registerGitCredentialInjector("github", null);
		const result = await runGit(dir, ["config", "--list"]);
		expect(result.stdout).not.toContain(MARKER);
	});

	it("injects nothing when the injector returns null (logged out)", async () => {
		registerGitCredentialInjector("github", async () => null);
		const result = await runGit(dir, ["config", "--list"]);
		expect(result.stdout).not.toContain(MARKER);
	});

	it("never breaks the git op when the injector throws", async () => {
		registerGitCredentialInjector("github", async () => {
			throw new Error("injector boom");
		});
		const result = await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("true");
	});

	it("merges the injector env into the spawn (does not clobber the base env)", async () => {
		registerGitCredentialInjector("github", async () => ({ args: [], env: { KANBAN_GIT_GITHUB_TOKEN: "tok" } }));
		const result = await runGit(dir, ["rev-parse", "--git-dir"]);
		expect(result.ok).toBe(true);
		expect(result.stdout).toContain(join(".git"));
	});
});
