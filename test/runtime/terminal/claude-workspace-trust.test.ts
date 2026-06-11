import { describe, expect, it } from "vitest";

import { shouldAutoConfirmClaudeWorkspaceTrust } from "../../../src/terminal/claude-workspace-trust";

describe("shouldAutoConfirmClaudeWorkspaceTrust", () => {
	it("auto-confirms inside a repo-rooted kanban worktree", () => {
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", "/home/me/proj/.kanban/worktrees/abc12/proj")).toBe(true);
	});

	it("does not auto-confirm an arbitrary path outside a kanban worktree", () => {
		expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", "/home/me/proj")).toBe(false);
	});

	it("only applies to the claude agent", () => {
		expect(shouldAutoConfirmClaudeWorkspaceTrust("codex", "/home/me/proj/.kanban/worktrees/abc12/proj")).toBe(false);
	});
});
