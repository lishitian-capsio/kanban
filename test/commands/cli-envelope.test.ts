import { describe, expect, it } from "vitest";

import {
	CLI_ERROR_CODES,
	CLI_EXIT_CONFLICT,
	CLI_EXIT_NOT_FOUND,
	CLI_EXIT_RUNTIME_ERROR,
	CLI_EXIT_RUNTIME_UNREACHABLE,
	CLI_SCHEMA_VERSION,
	CliError,
	buildFailureEnvelope,
	buildSuccessEnvelope,
	classifyError,
	exitCodeForErrorCode,
	resolveOutputMode,
} from "../../src/commands/cli-envelope";

describe("cli-envelope success envelope", () => {
	it("wraps data in a versioned ok=true envelope", () => {
		const envelope = buildSuccessEnvelope("task.list", { count: 2, tasks: [] });
		expect(envelope).toEqual({
			schemaVersion: "1",
			ok: true,
			command: "task.list",
			data: { count: 2, tasks: [] },
		});
	});

	it("uses the stable schema version constant", () => {
		expect(CLI_SCHEMA_VERSION).toBe("1");
		expect(buildSuccessEnvelope("file.list", {}).schemaVersion).toBe(CLI_SCHEMA_VERSION);
	});

	it("includes warnings only when provided", () => {
		const without = buildSuccessEnvelope("task.list", {});
		expect(without).not.toHaveProperty("warnings");

		const withWarnings = buildSuccessEnvelope("task.trash", {}, [
			{ code: "deprecated_alias", message: "`task trash` is deprecated; use `task done`." },
		]);
		expect(withWarnings.warnings).toEqual([
			{ code: "deprecated_alias", message: "`task trash` is deprecated; use `task done`." },
		]);
	});
});

describe("cli-envelope failure envelope", () => {
	it("emits a structured error object plus a legacy top-level string mirror", () => {
		const envelope = buildFailureEnvelope(
			"task.update",
			{ code: "task_not_found", message: 'No task with id "abc".', details: { taskId: "abc" } },
			'Task command failed at http://127.0.0.1:3484: No task with id "abc".',
		);
		expect(envelope).toEqual({
			schemaVersion: "1",
			ok: false,
			command: "task.update",
			error: {
				code: "task_not_found",
				message: 'No task with id "abc".',
				details: { taskId: "abc" },
			},
			errorMessage: 'Task command failed at http://127.0.0.1:3484: No task with id "abc".',
		});
	});

	it("keeps the legacy mirror parseable as a string for old readers", () => {
		const envelope = buildFailureEnvelope(
			"db.tables",
			{ code: "internal_error", message: "boom" },
			"Database command failed at http://127.0.0.1:3484: boom",
		);
		expect(typeof envelope.errorMessage).toBe("string");
		expect(envelope.error.message).toBe("boom");
	});
});

describe("exitCodeForErrorCode", () => {
	it("maps not-found codes to exit 3", () => {
		for (const code of [
			"workspace_not_found",
			"task_not_found",
			"file_not_found",
			"document_not_found",
			"connection_not_found",
		] as const) {
			expect(exitCodeForErrorCode(code)).toBe(CLI_EXIT_NOT_FOUND);
		}
	});

	it("maps runtime_unreachable to exit 4", () => {
		expect(exitCodeForErrorCode("runtime_unreachable")).toBe(CLI_EXIT_RUNTIME_UNREACHABLE);
	});

	it("maps conflict/precondition codes to exit 5", () => {
		expect(exitCodeForErrorCode("dependency_cycle")).toBe(CLI_EXIT_CONFLICT);
		expect(exitCodeForErrorCode("write_not_allowed")).toBe(CLI_EXIT_CONFLICT);
	});

	it("maps the remaining handler errors to exit 1", () => {
		for (const code of [
			"invalid_argument",
			"validation_failed",
			"passcode_not_set",
			"service_unsupported_platform",
			"internal_error",
		] as const) {
			expect(exitCodeForErrorCode(code)).toBe(CLI_EXIT_RUNTIME_ERROR);
		}
	});

	it("covers every enum member deterministically", () => {
		for (const code of CLI_ERROR_CODES) {
			const exit = exitCodeForErrorCode(code);
			expect([
				CLI_EXIT_RUNTIME_ERROR,
				CLI_EXIT_NOT_FOUND,
				CLI_EXIT_RUNTIME_UNREACHABLE,
				CLI_EXIT_CONFLICT,
			]).toContain(exit);
		}
	});
});

describe("classifyError", () => {
	it("passes a CliError through with its code and details", () => {
		const classified = classifyError(new CliError("task_not_found", "missing", { taskId: "x" }));
		expect(classified).toEqual({ code: "task_not_found", message: "missing", details: { taskId: "x" } });
	});

	it("classifies connection-refused style errors as runtime_unreachable", () => {
		expect(classifyError(new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:3484")).code).toBe(
			"runtime_unreachable",
		);
	});

	it("falls back to internal_error for unknown errors", () => {
		expect(classifyError(new Error("something odd")).code).toBe("internal_error");
		expect(classifyError("a bare string").code).toBe("internal_error");
	});
});

describe("resolveOutputMode precedence", () => {
	it("prefers an explicit --json flag over everything else", () => {
		expect(
			resolveOutputMode({ jsonFlag: true, humanFlag: false, envValue: "human", stdoutIsTTY: true }),
		).toBe("json");
	});

	it("prefers an explicit --human flag over env and tty", () => {
		expect(
			resolveOutputMode({ jsonFlag: false, humanFlag: true, envValue: "json", stdoutIsTTY: false }),
		).toBe("human");
	});

	it("honors KANBAN_OUTPUT when no flag is set", () => {
		expect(resolveOutputMode({ envValue: "json", stdoutIsTTY: true })).toBe("json");
		expect(resolveOutputMode({ envValue: "human", stdoutIsTTY: false })).toBe("human");
	});

	it("auto-selects machine output when stdout is not a TTY", () => {
		expect(resolveOutputMode({ stdoutIsTTY: false })).toBe("json");
	});

	it("auto-selects human output on a TTY", () => {
		expect(resolveOutputMode({ stdoutIsTTY: true })).toBe("human");
	});
});
