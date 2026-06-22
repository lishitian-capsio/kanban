// Purpose-neutral: this carries the id of the session/task the spawned process
// belongs to. It is consumed both by the hooks ingest path and by the
// task-creation path (which derives a new task's default agent from the calling
// session), so the name must not be hook-specific.
export const KANBAN_SESSION_TASK_ID_ENV = "KANBAN_SESSION_TASK_ID";
export const KANBAN_SESSION_WORKSPACE_ID_ENV = "KANBAN_SESSION_WORKSPACE_ID";

export interface HookRuntimeContext {
	taskId: string;
	workspaceId: string;
}

function requireTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return value;
}

export function createHookRuntimeEnv(context: HookRuntimeContext): Record<string, string> {
	return {
		[KANBAN_SESSION_TASK_ID_ENV]: context.taskId,
		[KANBAN_SESSION_WORKSPACE_ID_ENV]: context.workspaceId,
	};
}

export function parseHookRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): HookRuntimeContext {
	const taskId = requireTrimmedEnv(env, KANBAN_SESSION_TASK_ID_ENV);
	const workspaceId = requireTrimmedEnv(env, KANBAN_SESSION_WORKSPACE_ID_ENV);
	return {
		taskId,
		workspaceId,
	};
}

/**
 * Non-throwing variant of {@link parseHookRuntimeContextFromEnv}.
 * Returns `null` when the required env vars are absent — used by `hooks ingest`
 * so that stale persistent hook configs (e.g. in `~/.claude/settings.json`)
 * silently no-op when the user runs an agent outside of a Kanban session.
 */
export function tryParseHookRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): HookRuntimeContext | null {
	const taskId = env[KANBAN_SESSION_TASK_ID_ENV]?.trim();
	const workspaceId = env[KANBAN_SESSION_WORKSPACE_ID_ENV]?.trim();
	if (!taskId || !workspaceId) return null;
	return { taskId, workspaceId };
}
