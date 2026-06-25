import { promisify } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(childProcessMocks.execFile, {
		[promisify.custom]: childProcessMocks.execFilePromise,
	}),
}));

import {
	isLikelyGitRemoteUrl,
	readGitRemoteUrl,
	readGitUserIdentity,
	runGit,
	writeGitRemoteUrl,
	writeGitUserIdentity,
} from "../../src/workspace/git-utils";

function createExecError(options: {
	code: string | number;
	stdout?: string;
	stderr?: string;
	message?: string;
}): Error & { code: string | number; stdout: string; stderr: string } {
	const error = new Error(options.message ?? "git failed") as Error & {
		code: string | number;
		stdout: string;
		stderr: string;
	};
	error.code = options.code;
	error.stdout = options.stdout ?? "";
	error.stderr = options.stderr ?? "";
	return error;
}

describe("runGit", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
	});

	it("preserves raw stdout on exit code 1 when trimStdout is false", async () => {
		const diffOutput = "diff --git a/file b/file\n";
		childProcessMocks.execFilePromise.mockRejectedValueOnce(
			createExecError({
				code: 1,
				stdout: diffOutput,
				stderr: "",
			}),
		);

		const result = await runGit("/repo", ["diff", "--binary", "HEAD", "--"], { trimStdout: false });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe(diffOutput);
	});

	it("does not classify non-process failures as git exit code 1", async () => {
		childProcessMocks.execFilePromise.mockRejectedValueOnce(
			createExecError({
				code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
				stdout: "partial-output",
				stderr: "",
				message: "stdout maxBuffer length exceeded",
			}),
		);

		const result = await runGit("/repo", ["diff", "--binary", "HEAD", "--"], { trimStdout: false });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(-1);
		expect(result.stdout).toBe("partial-output");
	});
});

describe("readGitUserIdentity", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
	});

	function mockConfigValue(
		value: string,
	): (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }> {
		return async (_cmd, args) => {
			const key = args[args.length - 1];
			if (key === "user.name") {
				return {
					stdout: `${value === "name-only" ? "Ada Lovelace" : value === "email-only" ? "" : "Ada Lovelace"}\n`,
					stderr: "",
				};
			}
			return { stdout: `${value === "name-only" ? "" : "ada@example.com"}\n`, stderr: "" };
		};
	}

	it("returns the trimmed name and email", async () => {
		childProcessMocks.execFilePromise.mockImplementation(mockConfigValue("both"));
		const identity = await readGitUserIdentity("/repo");
		expect(identity).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
	});

	it("returns the configured field even when the other is missing", async () => {
		childProcessMocks.execFilePromise.mockImplementation(mockConfigValue("name-only"));
		const identity = await readGitUserIdentity("/repo");
		expect(identity).toEqual({ name: "Ada Lovelace", email: "" });
	});

	it("returns null when neither name nor email is configured", async () => {
		childProcessMocks.execFilePromise.mockRejectedValue(createExecError({ code: 1, stdout: "", stderr: "" }));
		const identity = await readGitUserIdentity("/repo");
		expect(identity).toBeNull();
	});
});

describe("writeGitUserIdentity", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
	});

	function recordedGitArgs(): string[][] {
		return childProcessMocks.execFilePromise.mock.calls.map(([, args]) =>
			(args as string[]).filter((arg) => arg !== "-c" && arg !== "core.quotepath=false"),
		);
	}

	it("writes repo-local user.name and user.email (never --global)", async () => {
		childProcessMocks.execFilePromise.mockResolvedValue({ stdout: "", stderr: "" });

		await writeGitUserIdentity("/repo", { name: "Ada Lovelace", email: "ada@example.com" });

		const calls = recordedGitArgs();
		expect(calls).toContainEqual(["config", "user.name", "Ada Lovelace"]);
		expect(calls).toContainEqual(["config", "user.email", "ada@example.com"]);
		for (const call of childProcessMocks.execFilePromise.mock.calls) {
			expect(call[1]).not.toContain("--global");
		}
	});

	it("clears an empty field via --unset, tolerating it being absent (exit 5)", async () => {
		childProcessMocks.execFilePromise.mockImplementation(async (_cmd, args: string[]) => {
			if (args.includes("--unset")) {
				throw createExecError({ code: 5, stdout: "", stderr: "" });
			}
			return { stdout: "", stderr: "" };
		});

		await expect(writeGitUserIdentity("/repo", { name: "Ada Lovelace", email: "" })).resolves.toBeUndefined();

		const calls = recordedGitArgs();
		expect(calls).toContainEqual(["config", "user.name", "Ada Lovelace"]);
		expect(calls).toContainEqual(["config", "--unset", "user.email"]);
	});

	it("throws when both name and email are empty", async () => {
		await expect(writeGitUserIdentity("/repo", { name: "  ", email: "" })).rejects.toThrow();
		expect(childProcessMocks.execFilePromise).not.toHaveBeenCalled();
	});

	it("throws with the git error when the config write fails (e.g. not a git repo)", async () => {
		childProcessMocks.execFilePromise.mockRejectedValue(
			createExecError({ code: 128, stdout: "", stderr: "fatal: not in a git directory" }),
		);

		await expect(writeGitUserIdentity("/repo", { name: "Ada Lovelace", email: "" })).rejects.toThrow(
			/not in a git directory/,
		);
	});
});

describe("isLikelyGitRemoteUrl", () => {
	it("accepts common https and scp-like ssh remotes", () => {
		expect(isLikelyGitRemoteUrl("https://github.com/owner/repo.git")).toBe(true);
		expect(isLikelyGitRemoteUrl("git@github.com:owner/repo.git")).toBe(true);
		expect(isLikelyGitRemoteUrl("ssh://git@host:22/owner/repo.git")).toBe(true);
		expect(isLikelyGitRemoteUrl("git://host/owner/repo.git")).toBe(true);
		expect(isLikelyGitRemoteUrl("file:///srv/git/repo.git")).toBe(true);
		expect(isLikelyGitRemoteUrl("/srv/git/repo.git")).toBe(true);
	});

	it("tolerates surrounding whitespace", () => {
		expect(isLikelyGitRemoteUrl("  https://github.com/owner/repo.git  ")).toBe(true);
	});

	it("rejects empty, whitespace-only, and malformed values", () => {
		expect(isLikelyGitRemoteUrl("")).toBe(false);
		expect(isLikelyGitRemoteUrl("   ")).toBe(false);
		expect(isLikelyGitRemoteUrl("not a url")).toBe(false);
		expect(isLikelyGitRemoteUrl("ftp//bad")).toBe(false);
	});
});

describe("readGitRemoteUrl", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
	});

	it("returns the trimmed origin url when configured", async () => {
		childProcessMocks.execFilePromise.mockResolvedValue({
			stdout: "https://github.com/owner/repo.git\n",
			stderr: "",
		});
		const url = await readGitRemoteUrl("/repo");
		expect(url).toBe("https://github.com/owner/repo.git");
	});

	it("returns null when origin is not configured", async () => {
		childProcessMocks.execFilePromise.mockRejectedValue(
			createExecError({ code: 2, stdout: "", stderr: "error: No such remote 'origin'" }),
		);
		const url = await readGitRemoteUrl("/repo");
		expect(url).toBeNull();
	});
});

describe("writeGitRemoteUrl", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
		childProcessMocks.execFilePromise.mockReset();
	});

	function recordedGitArgs(): string[][] {
		return childProcessMocks.execFilePromise.mock.calls.map(([, args]) =>
			(args as string[]).filter((arg) => arg !== "-c" && arg !== "core.quotepath=false"),
		);
	}

	it("adds origin when it does not exist yet", async () => {
		childProcessMocks.execFilePromise.mockImplementation(async (_cmd, args: string[]) => {
			if (args.includes("get-url")) {
				throw createExecError({ code: 2, stdout: "", stderr: "error: No such remote 'origin'" });
			}
			return { stdout: "", stderr: "" };
		});

		await writeGitRemoteUrl("/repo", "  https://github.com/owner/repo.git  ");

		expect(recordedGitArgs()).toContainEqual(["remote", "add", "origin", "https://github.com/owner/repo.git"]);
	});

	it("updates origin via set-url when it already exists", async () => {
		childProcessMocks.execFilePromise.mockImplementation(async (_cmd, args: string[]) => {
			if (args.includes("get-url")) {
				return { stdout: "https://old.example.com/repo.git\n", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});

		await writeGitRemoteUrl("/repo", "git@github.com:owner/repo.git");

		const calls = recordedGitArgs();
		expect(calls).toContainEqual(["remote", "set-url", "origin", "git@github.com:owner/repo.git"]);
		expect(calls).not.toContainEqual(["remote", "add", "origin", "git@github.com:owner/repo.git"]);
	});

	it("rejects a malformed url without touching git", async () => {
		await expect(writeGitRemoteUrl("/repo", "not a url")).rejects.toThrow();
		expect(childProcessMocks.execFilePromise).not.toHaveBeenCalled();
	});

	it("throws with the git error when the write fails", async () => {
		childProcessMocks.execFilePromise.mockImplementation(async (_cmd, args: string[]) => {
			if (args.includes("get-url")) {
				throw createExecError({ code: 2, stdout: "", stderr: "error: No such remote 'origin'" });
			}
			throw createExecError({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
		});

		await expect(writeGitRemoteUrl("/repo", "https://github.com/owner/repo.git")).rejects.toThrow(
			/not a git repository/,
		);
	});
});
