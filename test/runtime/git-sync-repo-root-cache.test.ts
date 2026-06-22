import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `probeGitWorkspaceState` resolves the repo root via `git rev-parse --show-toplevel`
// on every call. That root is an invariant for a given worktree path, but the workspace
// metadata monitor re-probes every tracked task once per second — so without caching,
// that constant spawns one wasted git process per task per tick. These tests pin the
// caching behavior by mocking `runGit` and counting the `--show-toplevel` spawns.

vi.mock("../../src/workspace/git-utils", () => ({
	runGit: vi.fn(),
}));

import { probeGitWorkspaceState } from "../../src/workspace/git-sync";
import { runGit } from "../../src/workspace/git-utils";

const runGitMock = vi.mocked(runGit);

function gitOk(stdout: string) {
	return {
		ok: true as const,
		stdout,
		stderr: "",
		output: stdout,
		error: null,
		exitCode: 0,
	};
}

function isToplevelCall(args: string[]): boolean {
	return args.includes("--show-toplevel");
}

beforeEach(() => {
	runGitMock.mockReset();
	runGitMock.mockImplementation(async (_cwd: string, args: string[]) => {
		if (isToplevelCall(args)) {
			return gitOk("/repo/root");
		}
		if (args[0] === "status") {
			return gitOk("# branch.head main\n# branch.ab +0 -0\n");
		}
		if (args[0] === "rev-parse" && args.includes("HEAD")) {
			return gitOk("abc123");
		}
		return gitOk("");
	});
});

afterEach(() => {
	runGitMock.mockReset();
});

describe("probeGitWorkspaceState repo-root caching", () => {
	it("resolves the repo root only once across repeated probes of the same cwd", async () => {
		const cwd = "/worktree/same-cwd-unique-a";

		await probeGitWorkspaceState(cwd);
		await probeGitWorkspaceState(cwd);
		await probeGitWorkspaceState(cwd);

		const toplevelCalls = runGitMock.mock.calls.filter(([, args]) => isToplevelCall(args));
		expect(toplevelCalls).toHaveLength(1);

		// The non-cacheable per-tick probes (status + HEAD) still run every time.
		const statusCalls = runGitMock.mock.calls.filter(([, args]) => args[0] === "status");
		expect(statusCalls).toHaveLength(3);
	});

	it("resolves the repo root separately for distinct worktree paths", async () => {
		await probeGitWorkspaceState("/worktree/distinct-cwd-unique-b");
		await probeGitWorkspaceState("/worktree/distinct-cwd-unique-c");

		const toplevelCalls = runGitMock.mock.calls.filter(([, args]) => isToplevelCall(args));
		expect(toplevelCalls).toHaveLength(2);
	});
});
