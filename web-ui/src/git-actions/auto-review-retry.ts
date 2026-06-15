import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";

export interface AutoReviewFailure {
	action: TaskGitAction;
	changedFiles: number;
}

/**
 * After an auto-review git action (commit/PR) fails, it must not be retried on a
 * tight ~500ms loop (which floods the screen with error toasts and never
 * converges). Skip re-scheduling while the recorded failure still matches the
 * current action and the working-tree signature (`changedFiles`) is unchanged.
 *
 * A meaningful change clears the block and allows a fresh attempt:
 * - a different action (commit vs pr), or
 * - a changed `changedFiles` count (a new diff = a legitimate new attempt).
 *
 * Leaving review, toggling auto-review, or the task disappearing are handled by
 * the caller clearing the record entirely.
 */
export function shouldSkipAfterFailure(
	failure: AutoReviewFailure | undefined,
	action: TaskGitAction,
	changedFiles: number,
): boolean {
	if (!failure) {
		return false;
	}
	return failure.action === action && failure.changedFiles === changedFiles;
}
