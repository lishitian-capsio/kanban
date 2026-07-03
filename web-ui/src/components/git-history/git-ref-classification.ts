/**
 * Classification of git refs surfaced in the Git History panel.
 *
 * Kanban maintains a few internal branches the user should never treat as
 * ordinary code branches:
 *   - `kanban/board` — the board *data* branch (board JSON / vault), checked
 *     out in a dedicated `__board__` worktree. Switching the main code tree to
 *     it would replace code with `.kanban` JSON, and git usually rejects it
 *     anyway (already checked out elsewhere). We keep it *visible* so its
 *     history is browsable, but forbid the double-click checkout.
 *   - `kanban/task/<id>` — per-task worktree branches (pure noise here).
 *   - `kanban/board-archive/<ts>` — archived board branches from renames.
 *
 * Branch names mirror the backend source of truth: `DEFAULT_BOARD_BRANCH`
 * (`src/state/board-ref.ts`), the `kanban/task/<id>` convention, and the
 * `kanban/board-archive` archive tag/branch prefix (`src/workspace/board-worktree.ts`).
 */

import type { RuntimeGitRef } from "@/runtime/types";

export type GitRefDisposition = "switchable" | "non-switchable" | "hidden";

/** The board *data* branch — visible (history browsable) but cannot be checked out. */
const BOARD_BRANCH_NAME = "kanban/board";
/** Per-task worktree branches — hidden from the branch list. */
const TASK_BRANCH_PREFIX = "kanban/task/";
/** Archived board branches from board-branch renames — hidden from the branch list. */
const BOARD_ARCHIVE_BRANCH_PREFIX = "kanban/board-archive/";

/**
 * Strip the leading remote name from a remote-tracking ref so internal-branch
 * detection works the same for `origin/kanban/board` as for `kanban/board`.
 * Remote names never contain a slash, so the first segment is the remote.
 */
function toLogicalBranchName(name: string, type: RuntimeGitRef["type"]): string {
	if (type !== "remote") {
		return name;
	}
	const slashIndex = name.indexOf("/");
	return slashIndex >= 0 ? name.slice(slashIndex + 1) : name;
}

/**
 * Decide how a git ref should behave in the refs panel: a normal switchable
 * branch, a visible-but-locked branch (the board data branch), or one hidden
 * entirely (task / board-archive branches). Pure and remote-aware.
 */
export function classifyGitRefDisposition(name: string, type: RuntimeGitRef["type"]): GitRefDisposition {
	const branchName = toLogicalBranchName(name, type);
	// Internal noise (task worktree branches, archived board branches/tags) is hidden
	// regardless of ref kind — a `kanban/board-archive/<ts>` archive *tag* is dropped
	// the same way its branch counterpart is.
	if (branchName.startsWith(TASK_BRANCH_PREFIX) || branchName.startsWith(BOARD_ARCHIVE_BRANCH_PREFIX)) {
		return "hidden";
	}
	// Tags are viewable history anchors, never checked out into the code working tree.
	if (type === "tag") {
		return "non-switchable";
	}
	if (branchName === BOARD_BRANCH_NAME) {
		return "non-switchable";
	}
	return "switchable";
}

/** Convenience: a ref that should be dropped from the branch list entirely. */
export function isHiddenGitRef(ref: Pick<RuntimeGitRef, "name" | "type">): boolean {
	return classifyGitRefDisposition(ref.name, ref.type) === "hidden";
}

/** Convenience: a ref that may be double-click checked out. */
export function isSwitchableGitRef(ref: Pick<RuntimeGitRef, "name" | "type">): boolean {
	return classifyGitRefDisposition(ref.name, ref.type) === "switchable";
}
