import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGitCredentialInjector, runGit } from "../../src/workspace/git-utils";
import { createTempDir } from "../utilities/temp-dir";

/**
 * The host-keyed credential registry: `runGit` asks EVERY registered per-host source and merges
 * their config args + env onto the one git invocation. The per-URL credential helper mechanism
 * lets multiple hosts (github.com, gitee.com, …) coexist on a single command without interfering.
 */
describe("runGit host-keyed credential registry", () => {
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
		registerGitCredentialInjector("gitee", null);
		registerGitCredentialInjector("boom", null);
		cleanup();
	});

	it("merges config args from multiple registered host sources onto one invocation", async () => {
		registerGitCredentialInjector("github", async () => ({
			args: ["-c", "credential.https://github.com.helper=!echo GH_MARKER"],
			env: { KANBAN_GIT_GITHUB_TOKEN: "gh" },
		}));
		registerGitCredentialInjector("gitee", async () => ({
			args: ["-c", "credential.https://gitee.com.helper=!echo GT_MARKER"],
			env: { KANBAN_GIT_GITEE_TOKEN: "gt" },
		}));

		const result = await runGit(dir, ["config", "--list"]);
		expect(result.ok).toBe(true);
		// Both hosts' per-URL helpers are present on the same git command.
		expect(result.stdout).toContain("credential.https://github.com.helper");
		expect(result.stdout).toContain("credential.https://gitee.com.helper");
		expect(result.stdout).toContain("GH_MARKER");
		expect(result.stdout).toContain("GT_MARKER");
	});

	it("a throwing source degrades to no injection without dropping the others", async () => {
		registerGitCredentialInjector("boom", async () => {
			throw new Error("source boom");
		});
		registerGitCredentialInjector("gitee", async () => ({
			args: ["-c", "credential.https://gitee.com.helper=!echo GT_MARKER"],
			env: {},
		}));

		const result = await runGit(dir, ["config", "--list"]);
		expect(result.ok).toBe(true);
		expect(result.stdout).toContain("GT_MARKER");
	});

	it("a null source (logged out of that host) contributes nothing but others still apply", async () => {
		// The github source is logged out (null) so it injects nothing of OURS; the gitee source
		// still applies. We assert on our unique markers rather than the generic helper key, since
		// the host's real git config may already carry a github.com credential helper.
		registerGitCredentialInjector("github", async () => null);
		registerGitCredentialInjector("gitee", async () => ({
			args: ["-c", "credential.https://gitee.com.helper=!echo GT_MARKER"],
			env: {},
		}));

		const result = await runGit(dir, ["config", "--list"]);
		expect(result.stdout).not.toContain("GH_MARKER");
		expect(result.stdout).toContain("GT_MARKER");
	});

	it("clearing a source removes its injection (passthrough)", async () => {
		registerGitCredentialInjector("gitee", async () => ({
			args: ["-c", "credential.https://gitee.com.helper=!echo GT_MARKER"],
			env: {},
		}));
		registerGitCredentialInjector("gitee", null);
		const result = await runGit(dir, ["config", "--list"]);
		expect(result.stdout).not.toContain("GT_MARKER");
	});
});
