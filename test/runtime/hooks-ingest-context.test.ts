import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseHooksIngestArgs } from "../../src/commands/hooks";
import {
	KANBAN_SESSION_TASK_ID_ENV,
	KANBAN_SESSION_WORKSPACE_ID_ENV,
} from "../../src/terminal/hook-runtime-context";

describe("parseHooksIngestArgs — session context gating", () => {
	let savedTaskId: string | undefined;
	let savedWorkspaceId: string | undefined;

	beforeEach(() => {
		savedTaskId = process.env[KANBAN_SESSION_TASK_ID_ENV];
		savedWorkspaceId = process.env[KANBAN_SESSION_WORKSPACE_ID_ENV];
	});

	afterEach(() => {
		if (savedTaskId === undefined) {
			delete process.env[KANBAN_SESSION_TASK_ID_ENV];
		} else {
			process.env[KANBAN_SESSION_TASK_ID_ENV] = savedTaskId;
		}
		if (savedWorkspaceId === undefined) {
			delete process.env[KANBAN_SESSION_WORKSPACE_ID_ENV];
		} else {
			process.env[KANBAN_SESSION_WORKSPACE_ID_ENV] = savedWorkspaceId;
		}
	});

	it("returns null (no-op) when the Kanban session env is absent", () => {
		// Stale persistent hooks in ~/.claude/settings.json fire for every claude run,
		// including plain shell terminals and claude invoked outside a Kanban session.
		// Ingest must silently no-op rather than throw a visible "UserPromptSubmit hook error".
		delete process.env[KANBAN_SESSION_TASK_ID_ENV];
		delete process.env[KANBAN_SESSION_WORKSPACE_ID_ENV];

		const result = parseHooksIngestArgs("to_in_progress", { source: "claude" }, undefined, "");

		expect(result).toBeNull();
	});

	it("returns null when only the workspace id is set", () => {
		delete process.env[KANBAN_SESSION_TASK_ID_ENV];
		process.env[KANBAN_SESSION_WORKSPACE_ID_ENV] = "workspace-1";

		const result = parseHooksIngestArgs("to_in_progress", { source: "claude" }, undefined, "");

		expect(result).toBeNull();
	});

	it("produces args for a normal task session (no regression)", () => {
		process.env[KANBAN_SESSION_TASK_ID_ENV] = "task-123";
		process.env[KANBAN_SESSION_WORKSPACE_ID_ENV] = "workspace-1";

		const result = parseHooksIngestArgs("to_in_progress", { source: "claude" }, undefined, "");

		expect(result).not.toBeNull();
		expect(result?.taskId).toBe("task-123");
		expect(result?.workspaceId).toBe("workspace-1");
		expect(result?.event).toBe("to_in_progress");
	});

	it("produces args for a home/board session's synthetic id", () => {
		const homeSessionId = "__home_agent__:workspace-1:claude:default";
		process.env[KANBAN_SESSION_TASK_ID_ENV] = homeSessionId;
		process.env[KANBAN_SESSION_WORKSPACE_ID_ENV] = "workspace-1";

		const result = parseHooksIngestArgs("to_in_progress", { source: "claude" }, undefined, "");

		expect(result).not.toBeNull();
		expect(result?.taskId).toBe(homeSessionId);
		expect(result?.workspaceId).toBe("workspace-1");
	});
});
