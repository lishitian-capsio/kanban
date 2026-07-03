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

function allPushCalls(): string[][] {
	return runGitMock.mock.calls.map((call) => call[1] as string[]).filter((args) => args[0] === "push");
}

// A mirror push targets an explicit remote URL; the primary push has none.
function isMirrorPush(args: string[]): boolean {
	return args.some((arg) => arg.startsWith("http"));
}

function mirrorPushCalls(): string[][] {
	return allPushCalls().filter(isMirrorPush);
}

function primaryPushCall(): string[] | undefined {
	return allPushCalls().find((args) => !isMirrorPush(args));
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
		// The primary push carries `--follow-tags` so locally-created annotated tags go
		// out with the branch on the normal unified push (no dedicated tag-push path).
		expect(primaryPushCall()).toEqual(["push", "--follow-tags"]);
		expect(mirrorPushCalls()).toEqual([
			["push", "--follow-tags", "https://gitee.com/o/r.git", "main:main"],
			["push", "--follow-tags", "https://example.com/o/r.git", "main:main"],
		]);
		expect(result.output).toContain("gitee");
		expect(result.output).toContain("2/2");
	});

	it("still mirrors when the primary push is a no-op (Everything up-to-date)", async () => {
		// Regression guard for the reported bug: when the primary remote is already
		// current, `git push` prints "Everything up-to-date" and exits 0. That success
		// must NOT be misread as "nothing changed, skip mirrors" — each mirror is
		// evaluated independently by git (ff / up-to-date / reject), so a mirror that is
		// behind the current branch still gets the branch pushed. The mirror stage is
		// gated only on the primary push *succeeding*, never on it transferring commits.
		runGitMock.mockImplementation(async (_cwd, args) => {
			// Primary push (no remote URL) is a no-op success.
			if (args[0] === "push" && !isMirrorPush(args)) return gitOk("Everything up-to-date");
			// Mirrors are behind, so their pushes actually transfer commits.
			if (args[0] === "push" && isMirrorPush(args)) return gitOk("abc123..def456  main -> main");
			return defaultDispatch(args);
		});

		const result = await runGitSyncAction({ cwd: "/repo-noop", action: "push", mirrorRemotes: mirrors });

		expect(result.ok).toBe(true);
		expect(result.output).toContain("Everything up-to-date");
		// Both mirrors are pushed the current branch despite the primary being a no-op.
		expect(mirrorPushCalls()).toEqual([
			["push", "--follow-tags", "https://gitee.com/o/r.git", "main:main"],
			["push", "--follow-tags", "https://example.com/o/r.git", "main:main"],
		]);
		expect(result.output).toContain("2/2");
	});

	it("keeps ok=true and reports the failure when a mirror push fails", async () => {
		runGitMock.mockImplementation(async (_cwd, args) => {
			if (args[0] === "push" && args.includes("https://gitee.com/o/r.git")) {
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
			if (args[0] === "push" && !isMirrorPush(args)) return gitFail("rejected");
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
