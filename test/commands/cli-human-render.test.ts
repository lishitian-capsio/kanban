import { describe, expect, it } from "vitest";
import {
	hintForErrorCode,
	renderHumanError,
	renderListResult,
	renderRecordResult,
	summarizeCollection,
} from "../../src/cli-human-render";

/** Strip ANSI CSI escapes so assertions read against plain text. */
function plain(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI escape we emit.
	return text.replace(/\[[0-9;]*m/g, "");
}

function hasAnsi(text: string): boolean {
	return text.includes("[");
}

describe("summarizeCollection", () => {
	it("counts items and breaks down by a recognized group field in canonical order", () => {
		const tasks = [
			...Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, column: "backlog" })),
			...Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, column: "in_progress" })),
			...Array.from({ length: 2 }, (_, i) => ({ id: `r${i}`, column: "review" })),
		];
		expect(summarizeCollection("tasks", tasks)).toBe("12 tasks · 7 backlog · 3 in_progress · 2 review");
	});

	it("singularizes the noun when there is exactly one item", () => {
		expect(summarizeCollection("connections", [{ id: "c1" }])).toBe("1 connection");
	});

	it("omits the breakdown when no group field is shared by every row", () => {
		expect(summarizeCollection("connections", [{ id: "c1" }, { id: "c2" }])).toBe("2 connections");
	});

	it("reports zero items without a breakdown", () => {
		expect(summarizeCollection("files", [])).toBe("0 files");
	});
});

describe("renderListResult", () => {
	const taskListData = {
		workspacePath: "/repo",
		column: null,
		count: 2,
		tasks: [
			{
				id: "task-aaaa",
				column: "in_progress",
				session: { state: "running" },
				agentId: "claude",
				prompt: "Implement a really long task title that should be truncated for the table view",
			},
			{ id: "task-bbbb", column: "review", session: null, prompt: "Short one" },
		],
		dependencies: [],
	};

	it("renders a curated task table with a colored header and a trailing summary", () => {
		const out = plain(renderListResult("task.list", taskListData, { useColor: false }));
		expect(out).toContain("ID");
		expect(out).toContain("COLUMN");
		expect(out).toContain("SESSION");
		expect(out).toContain("TITLE");
		expect(out).toContain("task-aaaa");
		expect(out).toContain("in_progress");
		expect(out).toContain("running");
		// The wide prompt is truncated with an ellipsis.
		expect(out).toContain("…");
		expect(out).not.toContain("truncated for the table view");
		// Trailing summary footer.
		expect(out.trim().split("\n").pop()).toBe("2 tasks · 1 in_progress · 1 review");
	});

	it("falls back to the empty session marker for tasks without a live session", () => {
		const out = plain(renderListResult("task.list", taskListData, { useColor: false }));
		const reviewRow = out.split("\n").find((line) => line.includes("task-bbbb")) ?? "";
		expect(reviewRow).toContain("—");
	});

	it("emits ANSI escapes only when color is enabled", () => {
		expect(hasAnsi(renderListResult("task.list", taskListData, { useColor: false }))).toBe(false);
		expect(hasAnsi(renderListResult("task.list", taskListData, { useColor: true }))).toBe(true);
	});

	it("renders a generic table for an unregistered list command", () => {
		const data = {
			workspacePath: "/repo",
			connections: [
				{ id: "pg", engine: "postgres", label: "Primary" },
				{ id: "lite", engine: "sqlite", label: "Local" },
			],
			count: 2,
		};
		const out = plain(renderListResult("db.connection.list", data, { useColor: false }));
		expect(out).toContain("pg");
		expect(out).toContain("postgres");
		expect(out).toContain("Primary");
		expect(out.trim().split("\n").pop()).toBe("2 connections");
	});

	it("shows an empty-state line and no table when the collection is empty", () => {
		const out = plain(
			renderListResult("file.list", { workspacePath: "/repo", files: [], count: 0 }, { useColor: false }),
		);
		expect(out).toContain("No files");
	});
});

describe("renderRecordResult", () => {
	it("renders a green success line, highlights the affected id, and lists scalar fields", () => {
		const out = renderRecordResult(
			"task.create",
			{ id: "task-xyz", column: "backlog", prompt: "Do it" },
			{ useColor: false },
		);
		const text = plain(out);
		expect(text).toContain("✓");
		expect(text).toContain("task-xyz");
		expect(text).toContain("backlog");
		expect(text).toContain("Do it");
	});

	it("renders nested object fields one level deep", () => {
		const out = plain(
			renderRecordResult("task.show", { id: "t1", session: { state: "running", pid: 42 } }, { useColor: false }),
		);
		expect(out).toContain("session");
		expect(out).toContain("running");
	});

	it("highlights the id with ANSI when color is enabled", () => {
		const colored = renderRecordResult("task.create", { id: "t1" }, { useColor: true });
		expect(hasAnsi(colored)).toBe(true);
		expect(renderRecordResult("task.create", { id: "t1" }, { useColor: false }).includes("[")).toBe(false);
	});
});

describe("renderHumanError", () => {
	it("renders a red cross, the message, the dim error code, and a hint when one applies", () => {
		const out = plain(
			renderHumanError({
				command: "task.update",
				message: 'No task with id "abc".',
				code: "task_not_found",
				useColor: false,
			}),
		);
		expect(out).toContain("✗");
		expect(out).toContain('No task with id "abc".');
		expect(out).toContain("(code: task_not_found)");
		// A not-found hint should point at the list command.
		expect(out.toLowerCase()).toContain("list");
	});

	it("omits the hint line for error codes that have none", () => {
		const out = plain(
			renderHumanError({ command: "db.query", message: "boom", code: "internal_error", useColor: false }),
		);
		expect(out).toContain("✗");
		expect(out).toContain("(code: internal_error)");
		expect(hintForErrorCode("internal_error")).toBeUndefined();
	});

	it("suppresses ANSI when color is disabled", () => {
		expect(
			renderHumanError({ command: "x", message: "m", code: "internal_error", useColor: false }).includes("["),
		).toBe(false);
	});
});

describe("hintForErrorCode", () => {
	it("provides actionable hints for the recoverable codes", () => {
		expect(hintForErrorCode("runtime_unreachable")?.toLowerCase()).toContain("kanban");
		expect(hintForErrorCode("workspace_not_found")?.toLowerCase()).toContain("project-path");
		expect(hintForErrorCode("write_not_allowed")?.toLowerCase()).toContain("allow-writes");
		expect(hintForErrorCode("passcode_not_set")?.toLowerCase()).toContain("passcode");
	});
});
