import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCliCommand } from "../../src/commands/cli-command-runner";
import { CliError } from "../../src/commands/cli-envelope";

function captureStdout(): { output: () => string; restore: () => void } {
	let buffer = "";
	const original = process.stdout.write.bind(process.stdout);
	const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
		buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	});
	return {
		output: () => buffer,
		restore: () => {
			spy.mockRestore();
			void original;
		},
	};
}

describe("runCliCommand machine mode", () => {
	beforeEach(() => {
		process.env.KANBAN_OUTPUT = "json";
		process.exitCode = undefined;
	});
	afterEach(() => {
		delete process.env.KANBAN_OUTPUT;
		process.exitCode = undefined;
	});

	it("emits exactly one JSON document with the success envelope", async () => {
		const capture = captureStdout();
		try {
			await runCliCommand("task.list", async () => ({ ok: true, count: 0, tasks: [] }));
		} finally {
			capture.restore();
		}
		const text = capture.output();
		const parsed = JSON.parse(text);
		expect(parsed).toMatchObject({
			schemaVersion: "1",
			ok: true,
			command: "task.list",
			data: { count: 0, tasks: [] },
		});
		// The top-level `ok` from the handler must be absorbed into the envelope, not duplicated in data.
		expect(parsed.data).not.toHaveProperty("ok");
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("renders a CliError as a structured failure envelope and sets the mapped exit code", async () => {
		const capture = captureStdout();
		try {
			await runCliCommand("task.update", async () => {
				throw new CliError("task_not_found", 'No task with id "abc".', { taskId: "abc" });
			});
		} finally {
			capture.restore();
		}
		const parsed = JSON.parse(capture.output());
		expect(parsed.ok).toBe(false);
		expect(parsed.command).toBe("task.update");
		expect(parsed.error).toEqual({
			code: "task_not_found",
			message: 'No task with id "abc".',
			details: { taskId: "abc" },
		});
		expect(typeof parsed.errorMessage).toBe("string");
		expect(parsed.errorMessage).toContain('No task with id "abc".');
		expect(process.exitCode).toBe(3);
	});

	it("maps an unclassified handler error to internal_error / exit 1", async () => {
		const capture = captureStdout();
		try {
			await runCliCommand("db.tables", async () => {
				throw new Error("kaboom");
			});
		} finally {
			capture.restore();
		}
		const parsed = JSON.parse(capture.output());
		expect(parsed.error.code).toBe("internal_error");
		expect(parsed.errorMessage).toContain("Database command failed");
		expect(process.exitCode).toBe(1);
	});

	it("forwards warnings into the success envelope", async () => {
		const capture = captureStdout();
		const err = captureStderr();
		try {
			await runCliCommand("task.trash", async () => ({ ok: true }), {
				warnings: [{ code: "deprecated_alias", message: "use `task done`" }],
			});
		} finally {
			err.restore();
			capture.restore();
		}
		const parsed = JSON.parse(capture.output());
		expect(parsed.warnings).toEqual([{ code: "deprecated_alias", message: "use `task done`" }]);
	});
});

function captureStderr(): { output: () => string; restore: () => void } {
	let buffer = "";
	const original = process.stderr.write.bind(process.stderr);
	const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
		buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	});
	return {
		output: () => buffer,
		restore: () => {
			spy.mockRestore();
			void original;
		},
	};
}

describe("runCliCommand deprecation warnings (two channels, P2)", () => {
	beforeEach(() => {
		process.env.KANBAN_OUTPUT = "json";
		process.exitCode = undefined;
		delete process.env.KANBAN_SUPPRESS_DEPRECATION;
	});
	afterEach(() => {
		delete process.env.KANBAN_OUTPUT;
		delete process.env.KANBAN_SUPPRESS_DEPRECATION;
		process.exitCode = undefined;
	});

	it("writes a one-line deprecation note to stderr (human channel)", async () => {
		const out = captureStdout();
		const err = captureStderr();
		try {
			await runCliCommand("task.done", async () => ({ ok: true }), {
				warnings: [{ code: "deprecated_alias", message: "`task trash` is deprecated; use `task done`." }],
			});
		} finally {
			err.restore();
			out.restore();
		}
		expect(err.output()).toContain("`task trash` is deprecated; use `task done`.");
		// The machine channel (stdout JSON) must NOT be polluted by the stderr note.
		expect(JSON.parse(out.output()).warnings).toEqual([
			{ code: "deprecated_alias", message: "`task trash` is deprecated; use `task done`." },
		]);
	});

	it("silences the stderr note under KANBAN_SUPPRESS_DEPRECATION=1 but keeps warnings[] in JSON", async () => {
		process.env.KANBAN_SUPPRESS_DEPRECATION = "1";
		const out = captureStdout();
		const err = captureStderr();
		try {
			await runCliCommand("task.update", async () => ({ ok: true }), {
				warnings: [{ code: "deprecated_flag", message: "`--task-id` is deprecated; pass `<id>` instead." }],
			});
		} finally {
			err.restore();
			out.restore();
		}
		expect(err.output()).toBe("");
		expect(JSON.parse(out.output()).warnings).toEqual([
			{ code: "deprecated_flag", message: "`--task-id` is deprecated; pass `<id>` instead." },
		]);
	});

	it("does not write non-deprecation warnings to stderr", async () => {
		const out = captureStdout();
		const err = captureStderr();
		try {
			await runCliCommand("task.list", async () => ({ ok: true }), {
				warnings: [{ code: "rate_limited", message: "slow down" }],
			});
		} finally {
			err.restore();
			out.restore();
		}
		expect(err.output()).toBe("");
	});

	it("emits the stderr note even when the command fails (deprecation is independent of outcome)", async () => {
		const out = captureStdout();
		const err = captureStderr();
		try {
			await runCliCommand(
				"task.done",
				async () => {
					throw new CliError("task_not_found", "nope", { taskId: "x" });
				},
				{ warnings: [{ code: "deprecated_alias", message: "`task trash` is deprecated; use `task done`." }] },
			);
		} finally {
			err.restore();
			out.restore();
		}
		expect(err.output()).toContain("`task trash` is deprecated");
		expect(JSON.parse(out.output()).ok).toBe(false);
		expect(process.exitCode).toBe(3);
	});
});

describe("runCliCommand human mode", () => {
	beforeEach(() => {
		process.env.KANBAN_OUTPUT = "human";
		process.exitCode = undefined;
	});
	afterEach(() => {
		delete process.env.KANBAN_OUTPUT;
		process.exitCode = undefined;
	});

	it("does not emit machine JSON on stdout in human mode", async () => {
		const capture = captureStdout();
		try {
			await runCliCommand("task.list", async () => ({ ok: true, count: 1, tasks: [] }));
		} finally {
			capture.restore();
		}
		const text = capture.output().trim();
		expect(() => JSON.parse(text)).toThrow();
		expect(text.length).toBeGreaterThan(0);
	});

	it("renders a list result as a table with a trailing summary footer", async () => {
		const capture = captureStdout();
		try {
			await runCliCommand("task.list", async () => ({
				ok: true,
				count: 1,
				tasks: [{ id: "abc", column: "review", session: null, prompt: "Hello" }],
			}));
		} finally {
			capture.restore();
		}
		const text = capture.output();
		expect(text).toContain("abc");
		expect(text).toContain("1 task · 1 review");
	});

	it("keeps the human stdout result clean — a deprecation note never lands on stdout", async () => {
		const capture = captureStdout();
		try {
			await runCliCommand("task.done", async () => ({ ok: true, id: "abc" }), {
				warnings: [{ code: "deprecated_alias", message: "`task trash` is deprecated; use `task done`." }],
			});
		} finally {
			capture.restore();
		}
		// The deprecation note is a human-channel stderr line (covered above); stdout must stay
		// a single clean result (the warning text is not duplicated there).
		const text = capture.output();
		expect(text).toContain("abc");
		expect(text).not.toContain("deprecated");
	});
});

describe("runCliCommand global flags (P1)", () => {
	beforeEach(() => {
		process.exitCode = undefined;
	});
	afterEach(() => {
		delete process.env.KANBAN_OUTPUT;
		process.exitCode = undefined;
	});

	it("globals.json forces machine output even when KANBAN_OUTPUT=human", async () => {
		process.env.KANBAN_OUTPUT = "human";
		const capture = captureStdout();
		try {
			await runCliCommand("task.list", async () => ({ ok: true, count: 0, tasks: [] }), {
				globals: { json: true, human: false, color: true, quiet: false },
			});
		} finally {
			capture.restore();
		}
		expect(JSON.parse(capture.output())).toMatchObject({ ok: true, command: "task.list" });
	});

	it("globals.human forces human output even when KANBAN_OUTPUT=json", async () => {
		process.env.KANBAN_OUTPUT = "json";
		const capture = captureStdout();
		try {
			await runCliCommand("task.list", async () => ({ ok: true, count: 0, tasks: [] }), {
				globals: { json: false, human: true, color: true, quiet: false },
			});
		} finally {
			capture.restore();
		}
		expect(() => JSON.parse(capture.output().trim())).toThrow();
	});

	it("globals.color=false suppresses ANSI escapes in human output", async () => {
		process.env.KANBAN_OUTPUT = "human";
		const capture = captureStdout();
		try {
			await runCliCommand("task.list", async () => ({ ok: true, count: 2, tasks: [] }), {
				globals: { json: false, human: true, color: false, quiet: false },
			});
		} finally {
			capture.restore();
		}
		// No ANSI CSI escape (ESC + "[") should appear when color is disabled.
		expect(capture.output()).not.toContain("\u001b[");
	});
});
