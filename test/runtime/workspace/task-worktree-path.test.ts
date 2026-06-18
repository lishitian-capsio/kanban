import { describe, expect, it } from "vitest";

import { BOARD_WORKTREE_SENTINEL, normalizeTaskIdForWorktreePath } from "../../../src/workspace/task-worktree-path";

describe("normalizeTaskIdForWorktreePath", () => {
	it("returns a trimmed task id unchanged", () => {
		expect(normalizeTaskIdForWorktreePath("  abc12  ")).toBe("abc12");
	});

	it("rejects ids that would escape the worktrees root", () => {
		expect(() => normalizeTaskIdForWorktreePath("a/b")).toThrow();
		expect(() => normalizeTaskIdForWorktreePath("..")).toThrow();
		expect(() => normalizeTaskIdForWorktreePath("")).toThrow();
	});

	it("rejects the reserved board worktree sentinel so a task can never collide with it", () => {
		expect(() => normalizeTaskIdForWorktreePath(BOARD_WORKTREE_SENTINEL)).toThrow();
		expect(() => normalizeTaskIdForWorktreePath(`  ${BOARD_WORKTREE_SENTINEL}  `)).toThrow();
	});
});
