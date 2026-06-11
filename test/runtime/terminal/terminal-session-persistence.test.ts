import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { FileSessionMessageJournal } from "../../../src/session/session-message-journal";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { TerminalTranscriptCapture } from "../../../src/terminal/terminal-transcript-capture";
import { createTempDir } from "../../utilities/temp-dir";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		mode: null,
		...overrides,
	};
}

function attachActiveEntry(manager: TerminalSessionManager, taskId: string): void {
	const entry = {
		summary: createSummary({ taskId, state: "running", agentId: "claude" }),
		active: { session: { write: vi.fn() } },
		transcript: new TerminalTranscriptCapture(taskId),
		captureChain: Promise.resolve(),
		listenerIdCounter: 1,
		listeners: new Map(),
	};
	(manager as unknown as { entries: Map<string, typeof entry> }).entries.set(taskId, entry);
}

describe("terminal session persistence", () => {
	it("persists captured input and replays it on a fresh manager after restart", async () => {
		const dir = createTempDir("kanban-terminal-persist-");
		try {
			const journalA = new FileSessionMessageJournal({ sessionsDir: dir.path });
			const managerA = new TerminalSessionManager({ messageJournal: journalA });
			attachActiveEntry(managerA, "task-1");
			managerA.writeInput("task-1", Buffer.from("remember this terminal input\r", "utf8"));
			await journalA.flush();

			const journalB = new FileSessionMessageJournal({ sessionsDir: dir.path });
			const managerB = new TerminalSessionManager({ messageJournal: journalB });
			managerB.hydrateFromRecord({ "task-1": createSummary({ taskId: "task-1" }) });

			const messages = await managerB.loadTaskSessionMessages("task-1");
			expect(messages.find((message) => message.content === "remember this terminal input")).toBeDefined();
		} finally {
			dir.cleanup();
		}
	});

	it("keeps the live in-memory transcript available without persistence configured", async () => {
		const manager = new TerminalSessionManager();
		attachActiveEntry(manager, "task-1");
		manager.writeInput("task-1", Buffer.from("live only\r", "utf8"));

		const messages = await manager.loadTaskSessionMessages("task-1");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toBe("live only");
	});
});
