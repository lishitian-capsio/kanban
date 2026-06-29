import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `runGitSyncAction` with `action: "push"` pushes the current branch to its upstream,
// then mirrors the same branch to each configured extra remote by URL. These tests pin
// that wiring by mocking `runGit` and dispatching responses by argv: a failed mirror
// push must not flip `ok` to false, and mirrors must only fire on a successful push.

vi.mock("../../src/workspace/git-utils", async () => {
	const actual = await vi.importActual<typeof import("../../src/workspace/git-utils")>(
		"../../src/workspace/git-utils",
	);
	return { ...actual, runGit: vi.fn() };
});

import type { RuntimeExtraPushRemote } from "../../src/core/api-contract";
import { runGitSyncAction } from "../../src/workspace/git-sync";
import { runGit } from "../../src/workspace/git-utils";

const runGitMock = vi.mocked(runGit);

function gitOk(stdout: string) {
	return { ok: true as const, stdout, stderr: "", output: stdout, error: null, exitCode: 0, timedOut: false };
}

function gitFail(error: string) {
	return { ok: false as const, stdout: "", stderr: error, output: error, error, exitCode: 1, timedOut: false };
}

const STATUS_STDOUT = ["# branch.head main", "# branch.upstream origin/main", "# branch.ab +1 -0"].join("\n");

// Default dispatcher: a healthy repo on `main` where every git command succeeds.
function defaultDispatch(args: string[]) {
	if (args.includes("--show-toplevel")) return gitOk("/repo");
	if (args[0] === "status") return gitOk(STATUS_STDOUT);
	if (args.includes("--verify") && args.includes("HEAD")) return gitOk("abc123");
	if (args[0] === "diff") return gitOk("");
	if (args[0] === "push") return gitOk("Everything up-to-date");
	return gitOk("");
}

const mirrors: RuntimeExtraPushRemote[] = [
	{ name: "gitee", url: "https://gitee.com/o/r.git" },
	{ name: "backup", url: "https://example.com/o/r.git" },
];

function mirrorPushCalls(): string[][] {
	return runGitMock.mock.calls
		.map((call) => call[1] as string[])
		.filter((args) => args[0] === "push" && args.length > 1);
}

beforeEach(() => {
	runGitMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runGitSyncAction mirror push", () => {
	it("pushes the current branch by URL to each configured mirror after a successful push", async () => {
		runGitMock.mockImplementation(async (_cwd, args) => defaultDispatch(args));

		const result = await runGitSyncAction({ cwd: "/repo-a", action: "push", mirrorRemotes: mirrors });

		expect(result.ok).toBe(true);
		expect(mirrorPushCalls()).toEqual([
			["push", "https://gitee.com/o/r.git", "main:main"],
			["push", "https://example.com/o/r.git", "main:main"],
		]);
		expect(result.output).toContain("gitee");
		expect(result.output).toContain("2/2");
	});

	it("keeps ok=true and reports the failure when a mirror push fails", async () => {
		runGitMock.mockImplementation(async (_cwd, args) => {
			if (args[0] === "push" && args[1] === "https://gitee.com/o/r.git") {
				return gitFail("remote: authentication failed");
			}
			return defaultDispatch(args);
		});

		const result = await runGitSyncAction({ cwd: "/repo-b", action: "push", mirrorRemotes: mirrors });

		expect(result.ok).toBe(true);
		expect(result.output).toContain("gitee");
		expect(result.output).toContain("authentication failed");
		// The second mirror still gets pushed despite the first failing.
		expect(mirrorPushCalls()).toHaveLength(2);
	});

	it("does not mirror when the primary push fails", async () => {
		runGitMock.mockImplementation(async (_cwd, args) => {
			if (args[0] === "push" && args.length === 1) return gitFail("rejected");
			return defaultDispatch(args);
		});

		const result = await runGitSyncAction({ cwd: "/repo-c", action: "push", mirrorRemotes: mirrors });

		expect(result.ok).toBe(false);
		expect(mirrorPushCalls()).toHaveLength(0);
	});

	it("does not mirror for non-push actions", async () => {
		runGitMock.mockImplementation(async (_cwd, args) => {
			if (args[0] === "fetch") return gitOk("");
			return defaultDispatch(args);
		});

		await runGitSyncAction({ cwd: "/repo-d", action: "fetch", mirrorRemotes: mirrors });

		expect(mirrorPushCalls()).toHaveLength(0);
	});

	it("does not mirror when no mirror remotes are configured", async () => {
		runGitMock.mockImplementation(async (_cwd, args) => defaultDispatch(args));

		const result = await runGitSyncAction({ cwd: "/repo-e", action: "push", mirrorRemotes: [] });

		expect(result.ok).toBe(true);
		expect(mirrorPushCalls()).toHaveLength(0);
		expect(result.output).not.toContain("Mirror push");
	});
});
