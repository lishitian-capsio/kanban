import { describe, expect, it } from "vitest";

import {
	createHookRuntimeEnv,
	KANBAN_SESSION_TASK_ID_ENV,
	KANBAN_SESSION_WORKSPACE_ID_ENV,
	parseHookRuntimeContextFromEnv,
} from "../../../src/terminal/hook-runtime-context";

describe("hook-runtime-context", () => {
	it("uses use-neutral env var names", () => {
		// The session task id var is reused by the task-creation path (not just hooks),
		// so the wire name must stay purpose-neutral.
		expect(KANBAN_SESSION_TASK_ID_ENV).toBe("KANBAN_SESSION_TASK_ID");
		expect(KANBAN_SESSION_WORKSPACE_ID_ENV).toBe("KANBAN_SESSION_WORKSPACE_ID");
	});

	it("creates expected environment variables", () => {
		const env = createHookRuntimeEnv({
			taskId: "task-1",
			workspaceId: "workspace-1",
		});
		expect(env).toEqual({
			[KANBAN_SESSION_TASK_ID_ENV]: "task-1",
			[KANBAN_SESSION_WORKSPACE_ID_ENV]: "workspace-1",
		});
	});

	it("parses hook runtime context from env", () => {
		const parsed = parseHookRuntimeContextFromEnv({
			[KANBAN_SESSION_TASK_ID_ENV]: "task-2",
			[KANBAN_SESSION_WORKSPACE_ID_ENV]: "workspace-2",
		});
		expect(parsed).toEqual({
			taskId: "task-2",
			workspaceId: "workspace-2",
		});
	});

	it("throws when required env vars are missing", () => {
		expect(() => parseHookRuntimeContextFromEnv({})).toThrow(
			`Missing required environment variable: ${KANBAN_SESSION_TASK_ID_ENV}`,
		);
	});
});
