const WORKTREE_TASK_ID_INVALID_MESSAGE = "Invalid task id for worktree path.";

export const KANBAN_RUNTIME_HOME_DIR_NAME = ".kanban";
export const KANBAN_TASK_WORKTREES_HOME_DIR_NAME = ".kanban/worktrees";
export const KANBAN_TASK_WORKTREES_DIR_NAME = "worktrees";
export const KANBAN_TASK_WORKTREES_DISPLAY_ROOT = `~/${KANBAN_TASK_WORKTREES_HOME_DIR_NAME}`;

/**
 * Reserved folder name (used in place of a task id) for the single per-repo board
 * worktree under `worktrees/`. Defined in this pure leaf so {@link
 * normalizeTaskIdForWorktreePath} can reject it without importing the
 * board-worktree module (which depends on this file). See `board-branch-decoupling.md` §3.2.
 */
export const BOARD_WORKTREE_SENTINEL = "__board__";

export function normalizeTaskIdForWorktreePath(taskId: string): string {
	const normalized = taskId.trim();
	if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
		throw new Error(WORKTREE_TASK_ID_INVALID_MESSAGE);
	}
	if (normalized === BOARD_WORKTREE_SENTINEL) {
		throw new Error(`Task id "${BOARD_WORKTREE_SENTINEL}" is reserved for the board worktree.`);
	}
	return normalized;
}

export function getWorkspaceFolderLabelForWorktreePath(repoPath: string): string {
	const trimmed = repoPath.trim().replace(/[\\/]+$/g, "");
	const folder =
		trimmed
			.split(/[\\/]/g)
			.filter((segment) => segment.length > 0)
			.at(-1) ?? "workspace";
	const cleaned = [...folder]
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
		.join("")
		.trim();
	return cleaned || "workspace";
}

export function buildTaskWorktreeDisplayPath(taskId: string, repoPath: string): string {
	const normalizedTaskId = normalizeTaskIdForWorktreePath(taskId);
	const workspaceLabel = getWorkspaceFolderLabelForWorktreePath(repoPath);
	return `${KANBAN_TASK_WORKTREES_DISPLAY_ROOT}/${normalizedTaskId}/${workspaceLabel}`;
}
