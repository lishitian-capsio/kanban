import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";

const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
let tempHome: string | null = null;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-codex-resume-"));
	process.env.CODEX_HOME = tempHome;
});

afterEach(() => {
	if (ORIGINAL_CODEX_HOME === undefined) {
		delete process.env.CODEX_HOME;
	} else {
		process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
	}
	tempHome = null;
});

function writeRollout(sessionId: string, cwd: string): void {
	const dir = join(tempHome ?? "", "sessions", "2026", "06", "22");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `rollout-2026-06-22T00-00-00-${sessionId}.jsonl`);
	const meta = JSON.stringify({
		type: "session_meta",
		payload: { id: sessionId, cwd, originator: "codex-tui" },
	});
	writeFileSync(file, `${meta}\n`);
}

const CWD = "/repo/worktree-codex";
const SESSION_ID = "019ddd7c-fe34-79c1-ba7e-408ca3103dff";

describe("codex adapter session resume", () => {
	it("does not add a resume subcommand on a fresh launch and exposes a capture hook", async () => {
		const launch = await prepareAgentLaunch({
			taskId: "task-fresh",
			agentId: "codex",
			args: [],
			cwd: CWD,
			prompt: "implement the feature",
		});

		expect(launch.args).not.toContain("resume");
		expect(typeof launch.captureAgentSessionId).toBe("function");
	});

	it("resumes the recorded session id positionally after `resume`", async () => {
		const launch = await prepareAgentLaunch({
			taskId: "task-restart",
			agentId: "codex",
			args: [],
			cwd: CWD,
			prompt: "keep going",
			agentSessionId: SESSION_ID,
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[resumeIndex + 1]).toBe(SESSION_ID);
		// The continuation prompt is forwarded as the trailing positional PROMPT.
		expect(launch.args).toContain("keep going");
		expect(launch.args.indexOf("keep going")).toBeGreaterThan(resumeIndex + 1);
	});

	it("ignores a non-UUID recorded session id (treated as no prior session)", async () => {
		const launch = await prepareAgentLaunch({
			taskId: "task-bad-id",
			agentId: "codex",
			args: [],
			cwd: CWD,
			prompt: "go",
			agentSessionId: "not-a-uuid",
		});

		expect(launch.args).not.toContain("resume");
	});

	it("captures the session id written after a fresh launch, then resumes it next launch", async () => {
		// First launch: no recorded id. The capture hook reads the rollout Codex
		// writes once its TUI boots.
		const first = await prepareAgentLaunch({
			taskId: "task-loop",
			agentId: "codex",
			args: [],
			cwd: CWD,
			prompt: "start",
		});
		expect(first.args).not.toContain("resume");

		// Simulate Codex writing the rollout for this session's cwd.
		writeRollout(SESSION_ID, CWD);

		const captured = await first.captureAgentSessionId?.({ startedAtMs: 0 });
		expect(captured).toBe(SESSION_ID);

		// Second launch (restart) with the captured id resumes the same conversation.
		const second = await prepareAgentLaunch({
			taskId: "task-loop",
			agentId: "codex",
			args: [],
			cwd: CWD,
			prompt: "continue",
			agentSessionId: captured,
		});
		const resumeIndex = second.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThanOrEqual(0);
		expect(second.args[resumeIndex + 1]).toBe(SESSION_ID);
	});
});
