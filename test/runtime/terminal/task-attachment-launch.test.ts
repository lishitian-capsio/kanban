import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeScopeAttachment } from "../../../src/terminal/session-attachment-store";
import { materializeTaskAttachmentsIntoPrompt } from "../../../src/terminal/task-attachment-launch";

const ATTACHMENTS_SUBDIR = join(".kanban", "attachments");

describe("materializeTaskAttachmentsIntoPrompt", () => {
	let repoRoot: string;
	let worktree: string;
	const taskId = "task-abc";

	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), "kanban-repo-"));
		worktree = mkdtempSync(join(tmpdir(), "kanban-worktree-"));
	});

	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true });
		rmSync(worktree, { recursive: true, force: true });
	});

	async function stage(name: string, contents: string): Promise<void> {
		const result = await writeScopeAttachment({
			scope: { root: repoRoot, scopeId: taskId },
			name,
			data: Buffer.from(contents).toString("base64"),
		});
		expect(result.ok).toBe(true);
	}

	it("relocates staged files into the worktree and appends their @-mentions for a supported agent", async () => {
		await stage("report.pdf", "alpha");

		const prompt = await materializeTaskAttachmentsIntoPrompt({
			prompt: "please review",
			agentId: "claude",
			workspaceRoot: repoRoot,
			worktreeCwd: worktree,
			taskId,
		});

		const worktreeDir = join(worktree, ATTACHMENTS_SUBDIR, taskId);
		// The prompt references the worktree path (not the staging path).
		expect(prompt).toMatch(/^please review\n\nAttached files: @/);
		expect(prompt).toContain(worktreeDir);
		// File physically moved into the worktree, staging removed.
		const mentioned = prompt.split("@").pop()?.trim();
		expect(mentioned && existsSync(mentioned)).toBe(true);
		expect(mentioned && readFileSync(mentioned).toString("utf8")).toBe("alpha");
		expect(existsSync(join(repoRoot, ATTACHMENTS_SUBDIR, taskId))).toBe(false);
	});

	it("leaves the prompt untouched for an unsupported agent and does not relocate", async () => {
		await stage("report.pdf", "alpha");

		const prompt = await materializeTaskAttachmentsIntoPrompt({
			prompt: "please review",
			agentId: "codex",
			workspaceRoot: repoRoot,
			worktreeCwd: worktree,
			taskId,
		});

		expect(prompt).toBe("please review");
		// Staging is untouched (not moved into the worktree).
		expect(existsSync(join(repoRoot, ATTACHMENTS_SUBDIR, taskId))).toBe(true);
		expect(existsSync(join(worktree, ATTACHMENTS_SUBDIR, taskId))).toBe(false);
	});

	it("returns the prompt unchanged when there are no staged files", async () => {
		const prompt = await materializeTaskAttachmentsIntoPrompt({
			prompt: "nothing attached",
			agentId: "claude",
			workspaceRoot: repoRoot,
			worktreeCwd: worktree,
			taskId,
		});
		expect(prompt).toBe("nothing attached");
	});

	it("degrades to the original prompt if relocation fails (e.g. unsafe task id)", async () => {
		const prompt = await materializeTaskAttachmentsIntoPrompt({
			prompt: "keep me",
			agentId: "claude",
			workspaceRoot: repoRoot,
			worktreeCwd: worktree,
			taskId: "../evil",
		});
		expect(prompt).toBe("keep me");
	});
});
