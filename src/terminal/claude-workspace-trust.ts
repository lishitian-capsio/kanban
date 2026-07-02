import type { RuntimeAgentId } from "../core/api-contract";
import { stripAnsiAndControl } from "./output-utils";

// Kanban task worktrees live at `<repoPath>/.kanban/worktrees/<taskId>/<label>`.
// A path-segment match is repo-agnostic, so the trust check needs no repoPath.
const TASK_WORKTREE_PATH_SEGMENT = "/.kanban/worktrees/";

export const WORKSPACE_TRUST_CONFIRM_DELAY_MS = 100;

function normalizeTerminalText(input: string): string {
	return input.toLowerCase().replace(/\s+/gu, " ");
}

export function hasClaudeWorkspaceTrustPrompt(text: string): boolean {
	const normalized = normalizeTerminalText(stripAnsiAndControl(text));
	return /yes,?\s*i\s*trust\s*this\s*folder/u.test(normalized) || /trust\s+this\s+folder/u.test(normalized);
}

function isTaskWorktreePath(path: string): boolean {
	const normalizedPath = path.replace(/\\/gu, "/");
	if (process.platform === "win32") {
		return normalizedPath.toLowerCase().includes(TASK_WORKTREE_PATH_SEGMENT);
	}
	return normalizedPath.includes(TASK_WORKTREE_PATH_SEGMENT);
}

export function shouldAutoConfirmClaudeWorkspaceTrust(agentId: RuntimeAgentId, cwd: string): boolean {
	return agentId === "claude" && isTaskWorktreePath(cwd);
}

export function stopWorkspaceTrustTimers(state: { workspaceTrustConfirmTimer: NodeJS.Timeout | null }): void {
	if (state.workspaceTrustConfirmTimer) {
		clearTimeout(state.workspaceTrustConfirmTimer);
		state.workspaceTrustConfirmTimer = null;
	}
}
