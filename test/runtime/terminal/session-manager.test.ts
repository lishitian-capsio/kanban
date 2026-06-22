import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { buildShellCommandLine } from "../../../src/core/shell";
import type { SessionMessage } from "../../../src/session/session-message";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { TerminalTranscriptCapture } from "../../../src/terminal/terminal-transcript-capture";

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
		...overrides,
	};
}

describe("TerminalSessionManager", () => {
	it("clears trust prompt state when transitioning to review", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ state: "running", reviewReason: null }),
			active: {
				workspaceTrustBuffer: "trust this folder",
				awaitingCodexPromptAfterEnter: true,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		const applySessionEvent = (
			manager as unknown as {
				applySessionEvent: (sessionEntry: unknown, event: { type: "hook.to_review" }) => RuntimeTaskSessionSummary;
			}
		).applySessionEvent;
		const nextSummary = applySessionEvent(entry, { type: "hook.to_review" });
		expect(nextSummary.state).toBe("awaiting_review");
		expect(entry.active.workspaceTrustBuffer).toBe("");
	});

	it("builds shell kickoff command lines with quoted arguments", () => {
		const commandLine = buildShellCommandLine("cline", ["--auto-approve-all", "hello world"]);
		expect(commandLine).toContain("cline");
		expect(commandLine).toContain("--auto-approve-all");
		expect(commandLine).toContain("hello world");
	});

	it("stores hook activity metadata on sessions", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const updated = manager.applyHookActivity("task-1", {
			source: "claude",
			activityText: "Using Read",
			toolName: "Read",
		});

		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Read");
		expect(typeof updated?.lastHookAt).toBe("number");
	});

	it("preserves a recorded agent session id across hydration from persisted state", () => {
		// Mirrors the restart path: sessions.json is read back and hydrated into the manager,
		// from where the next launch reads the pinned id and resumes the same conversation.
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-resume": createSummary({
				taskId: "task-resume",
				state: "interrupted",
				agentId: "claude",
				agentSessionId: "550e8400-e29b-41d4-a716-446655440000",
			}),
		});

		expect(manager.getSummary("task-resume")?.agentSessionId).toBe("550e8400-e29b-41d4-a716-446655440000");
	});

	it("closes a session: removes the entry and clears its persisted transcript", async () => {
		const clear = vi.fn(async () => undefined);
		const journal = {
			recordMessage: vi.fn(),
			getGeneration: vi.fn(() => 0),
			loadMessages: vi.fn(async () => []),
			clear,
			flush: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		};
		const manager = new TerminalSessionManager({ messageJournal: journal });
		manager.hydrateFromRecord({
			"task-close": createSummary({ taskId: "task-close", state: "interrupted" }),
		});

		await manager.closeTaskSession("task-close");

		expect(manager.getSummary("task-close")).toBeNull();
		expect(clear).toHaveBeenCalledWith("task-close");
	});

	it("resets stale running sessions without active processes", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("idle");
		expect(recovered?.pid).toBeNull();
		expect(recovered?.agentId).toBe("claude");
		expect(recovered?.workspacePath).toBeNull();
		expect(recovered?.reviewReason).toBeNull();
	});

	it("tracks only the latest two turn checkpoints", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		manager.applyTurnCheckpoint("task-1", {
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 1,
		});
		manager.applyTurnCheckpoint("task-1", {
			turn: 2,
			ref: "refs/kanban/checkpoints/task-1/turn/2",
			commit: "2222222",
			createdAt: 2,
		});

		const summary = manager.getSummary("task-1");
		expect(summary?.latestTurnCheckpoint?.turn).toBe(2);
		expect(summary?.previousTurnCheckpoint?.turn).toBe(1);
	});

	it("does not replay raw PTY history when attaching an output listener", () => {
		const manager = new TerminalSessionManager();
		const onOutput = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-probe", state: "running" }),
			active: {
				session: {},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-probe", entry);

		manager.attach("task-probe", {
			onOutput,
		});

		expect(onOutput).not.toHaveBeenCalled();
		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(false);
	});

	it("keeps the startup probe filter enabled when only a non-output listener attaches", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ taskId: "task-control-first", state: "running" }),
			active: {
				session: {
					write: vi.fn(),
				},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-control-first", entry);

		manager.attach("task-control-first", {
			onState: vi.fn(),
			onExit: vi.fn(),
		});

		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(true);
		expect(entry.active.terminalProtocolFilter.pendingChunk).toBeNull();
	});

	it("forwards pixel dimensions through resize when provided", () => {
		const manager = new TerminalSessionManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-resize", state: "running" }),
			active: {
				session: {
					resize: resizeSpy,
				},
				cols: 80,
				rows: 24,
			},
			terminalStateMirror: {
				resize: resizeMirrorSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-resize", entry);

		const resized = manager.resize("task-resize", 100, 30, 1200, 720);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30, 1200, 720);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30);
	});

	it("captures follow-up agent input as a user message on Enter", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ taskId: "task-input", state: "running", agentId: "claude" }),
			active: {
				session: { write: vi.fn() },
			},
			transcript: new TerminalTranscriptCapture("task-input"),
			captureChain: Promise.resolve(),
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-input", entry);

		const received: SessionMessage[] = [];
		manager.onMessage((_taskId, message) => {
			received.push(message);
		});

		manager.writeInput("task-input", Buffer.from("run the tests\r", "utf8"));

		expect(received).toHaveLength(1);
		expect(received[0]?.role).toBe("user");
		expect(received[0]?.content).toBe("run the tests");
		expect(manager.listMessages("task-input")).toHaveLength(1);
	});

	it("does not capture input for shell sessions without an agent", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ taskId: "task-shell", state: "running", agentId: null }),
			active: {
				session: { write: vi.fn() },
			},
			transcript: new TerminalTranscriptCapture("task-shell"),
			captureChain: Promise.resolve(),
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-shell", entry);

		const received: SessionMessage[] = [];
		manager.onMessage((_taskId, message) => {
			received.push(message);
		});

		manager.writeInput("task-shell", Buffer.from("ls -la\r", "utf8"));

		expect(received).toHaveLength(0);
		expect(manager.listMessages("task-shell")).toHaveLength(0);
	});

	it("captures committed scrollback as an assistant message when entering review", async () => {
		const manager = new TerminalSessionManager();
		const getCommittedLines = vi.fn(async () => ["I read the file.", "All done."]);
		const entry = {
			summary: createSummary({ taskId: "task-turn", state: "running", agentId: "claude", reviewReason: null }),
			active: {
				workspaceTrustBuffer: null,
				awaitingCodexPromptAfterEnter: false,
			},
			terminalStateMirror: { getCommittedLines },
			transcript: new TerminalTranscriptCapture("task-turn"),
			captureChain: Promise.resolve(),
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-turn", entry);

		const received: SessionMessage[] = [];
		manager.onMessage((_taskId, message) => {
			received.push(message);
		});

		manager.transitionToReview("task-turn", "hook");
		await entry.captureChain;

		expect(getCommittedLines).toHaveBeenCalledTimes(1);
		expect(received).toHaveLength(1);
		expect(received[0]?.role).toBe("assistant");
		expect(received[0]?.content).toBe("I read the file.\nAll done.");
	});

	it("returns the latest terminal restore snapshot when available", async () => {
		const manager = new TerminalSessionManager();
		const getSnapshotSpy = vi.fn(async () => ({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		}));
		const entry = {
			summary: createSummary({ taskId: "task-restore", state: "running" }),
			active: null,
			terminalStateMirror: {
				getSnapshot: getSnapshotSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-restore", entry);

		const snapshot = await manager.getRestoreSnapshot("task-restore");

		expect(snapshot).toEqual({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		});
		expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
	});
});
