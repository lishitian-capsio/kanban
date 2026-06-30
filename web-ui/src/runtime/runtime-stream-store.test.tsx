import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	dispatchRuntimeStreamAction,
	getRuntimeStreamStore,
	OPS_METRICS_HISTORY_LIMIT,
	resetRuntimeStreamStoreForTest,
	TASK_CHAT_MESSAGE_LIMIT,
	useRuntimeBoardSyncStatus,
	useRuntimeOpsMetrics,
	useRuntimeProjects,
	useRuntimeWorkspaceState,
	useTaskChatMessages,
	useTaskSessionSummary,
} from "@/runtime/runtime-stream-store";
import type {
	RuntimeBoardCard,
	RuntimeBoardSyncStatus,
	RuntimeOpsMetrics,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "@/runtime/types";

function makeMessage(id: string, content: string): RuntimeTaskChatMessage {
	return { id, role: "assistant", content, createdAt: 1 };
}

function makeBoardCard(id: string): RuntimeBoardCard {
	return { id, title: id, prompt: id, startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };
}

// A minimal workspace-state response whose board holds the given task ids (all
// in one column — the eviction diff only reads card ids, not columns).
function makeWorkspaceState(taskIds: string[]): RuntimeWorkspaceStateResponse {
	return {
		repoPath: "/repo",
		statePath: "/repo/.kanban",
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		board: {
			columns: [{ id: "in_progress", title: "In Progress", cards: taskIds.map(makeBoardCard) }],
			dependencies: [],
		},
		sessions: {},
		revision: 1,
	};
}

function sendChat(taskId: string, messageId: string): void {
	dispatchRuntimeStreamAction({
		type: "task_chat_message",
		payload: { type: "task_chat_message", workspaceId: "ws", taskId, message: makeMessage(messageId, "hi") },
	});
}

function makeSessionSummary(
	taskId: string,
	updatedAt: number,
	state: RuntimeTaskSessionSummary["state"],
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
	};
}

const boardSyncStatus: RuntimeBoardSyncStatus = {
	state: "synced",
	decoupled: true,
	branch: "kanban/board",
	hasRemote: true,
	aheadCount: 0,
	behindCount: 0,
	autoSyncPaused: false,
	lastError: null,
	worktreePath: "/tmp/board",
};

const opsMetrics: RuntimeOpsMetrics = {
	rssBytes: 506_535_936,
	cpuPercent: 12.5,
	eventLoopStalled: false,
	sampledAtMs: 1_000,
};

describe("runtime-stream-store granular subscriptions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		resetRuntimeStreamStoreForTest();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		resetRuntimeStreamStoreForTest();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("only re-renders the consumers whose slice changed", () => {
		const renders = { chatA: 0, chatB: 0, boardSync: 0, projects: 0, opsMetrics: 0 };

		function Harness(): null {
			useTaskChatMessages("task-a");
			renders.chatA += 1;
			return null;
		}
		function HarnessB(): null {
			useTaskChatMessages("task-b");
			renders.chatB += 1;
			return null;
		}
		function HarnessBoardSync(): null {
			useRuntimeBoardSyncStatus();
			renders.boardSync += 1;
			return null;
		}
		function HarnessProjects(): null {
			useRuntimeProjects();
			renders.projects += 1;
			return null;
		}
		function HarnessOpsMetrics(): null {
			useRuntimeOpsMetrics();
			renders.opsMetrics += 1;
			return null;
		}

		act(() => {
			root.render(
				<>
					<Harness />
					<HarnessB />
					<HarnessBoardSync />
					<HarnessProjects />
					<HarnessOpsMetrics />
				</>,
			);
		});

		const baseline = { ...renders };

		// A chat token for task-a wakes only task-a's consumer.
		act(() => {
			dispatchRuntimeStreamAction({
				type: "task_chat_message",
				payload: {
					type: "task_chat_message",
					workspaceId: "ws",
					taskId: "task-a",
					message: makeMessage("m1", "hello"),
				},
			});
		});

		expect(renders.chatA).toBe(baseline.chatA + 1);
		expect(renders.chatB).toBe(baseline.chatB);
		expect(renders.boardSync).toBe(baseline.boardSync);
		expect(renders.projects).toBe(baseline.projects);

		// A board-sync broadcast wakes only the board-sync badge — not the chat.
		const afterChat = { ...renders };
		act(() => {
			dispatchRuntimeStreamAction({
				type: "board_sync_status_updated",
				payload: { type: "board_sync_status_updated", workspaceId: "ws", status: boardSyncStatus },
			});
		});

		expect(renders.boardSync).toBe(afterChat.boardSync + 1);
		expect(renders.chatA).toBe(afterChat.chatA);
		expect(renders.chatB).toBe(afterChat.chatB);
		expect(renders.projects).toBe(afterChat.projects);
		expect(renders.opsMetrics).toBe(afterChat.opsMetrics);

		// A runtime-metrics broadcast wakes only the ops status bar — nothing else.
		const afterBoardSync = { ...renders };
		act(() => {
			dispatchRuntimeStreamAction({
				type: "runtime_metrics_updated",
				payload: { type: "runtime_metrics_updated", metrics: opsMetrics },
			});
		});

		expect(renders.opsMetrics).toBe(afterBoardSync.opsMetrics + 1);
		expect(renders.boardSync).toBe(afterBoardSync.boardSync);
		expect(renders.chatA).toBe(afterBoardSync.chatA);
		expect(renders.chatB).toBe(afterBoardSync.chatB);
		expect(renders.projects).toBe(afterBoardSync.projects);
	});

	it("task_sessions_updated wakes only the affected card's session subscriber, not the workspaceState slice", () => {
		const renders = { sessionA: 0, sessionB: 0, workspaceState: 0 };

		function HarnessSessionA(): null {
			useTaskSessionSummary("task-a");
			renders.sessionA += 1;
			return null;
		}
		function HarnessSessionB(): null {
			useTaskSessionSummary("task-b");
			renders.sessionB += 1;
			return null;
		}
		function HarnessWorkspaceState(): null {
			useRuntimeWorkspaceState();
			renders.workspaceState += 1;
			return null;
		}

		act(() => {
			root.render(
				<>
					<HarnessSessionA />
					<HarnessSessionB />
					<HarnessWorkspaceState />
				</>,
			);
		});
		const baseline = { ...renders };

		// A session tick for task-a wakes only task-a's leaf subscriber. The
		// App-level workspaceState slice must NOT re-render (this is the whole
		// point of the per-task slice — the board subtree stays put).
		act(() => {
			dispatchRuntimeStreamAction({
				type: "task_sessions_updated",
				summaries: [makeSessionSummary("task-a", 10, "running")],
			});
		});

		expect(renders.sessionA).toBe(baseline.sessionA + 1);
		expect(renders.sessionB).toBe(baseline.sessionB);
		expect(renders.workspaceState).toBe(baseline.workspaceState);
		expect(getRuntimeStreamStore().sessionSummaryByTaskId["task-a"]?.state).toBe("running");
	});

	it("ignores a stale (older updatedAt) session summary — monotonic merge", () => {
		dispatchRuntimeStreamAction({
			type: "task_sessions_updated",
			summaries: [makeSessionSummary("task-a", 20, "running")],
		});
		// An older summary for the same task must not overwrite the newer one
		// (guards the documented "terminal randomly clears out" regression).
		dispatchRuntimeStreamAction({
			type: "task_sessions_updated",
			summaries: [makeSessionSummary("task-a", 10, "idle")],
		});
		expect(getRuntimeStreamStore().sessionSummaryByTaskId["task-a"]?.state).toBe("running");
		expect(getRuntimeStreamStore().sessionSummaryByTaskId["task-a"]?.updatedAt).toBe(20);
	});

	it("does not re-emit when a dispatch leaves a field unchanged", () => {
		let projectsRenders = 0;
		function HarnessProjects(): null {
			useRuntimeProjects();
			projectsRenders += 1;
			return null;
		}

		act(() => {
			root.render(<HarnessProjects />);
		});
		const baseline = projectsRenders;

		// task_sessions_updated with no workspaceState is a no-op (reducer returns
		// the same store reference) — no listener should fire.
		act(() => {
			dispatchRuntimeStreamAction({ type: "task_sessions_updated", summaries: [] });
		});
		expect(projectsRenders).toBe(baseline);
	});

	it("initialize seeds currentProjectId without flagging a switch", () => {
		dispatchRuntimeStreamAction({ type: "initialize", requestedWorkspaceId: "ws-1" });
		expect(getRuntimeStreamStore().currentProjectId).toBe("ws-1");
		expect(getRuntimeStreamStore().hasReceivedSnapshot).toBe(false);
	});

	it("accumulates ops-metrics samples and caps the history buffer", () => {
		const sampleCount = OPS_METRICS_HISTORY_LIMIT + 5;
		for (let i = 0; i < sampleCount; i += 1) {
			dispatchRuntimeStreamAction({
				type: "runtime_metrics_updated",
				payload: {
					type: "runtime_metrics_updated",
					metrics: { ...opsMetrics, cpuPercent: i, sampledAtMs: i },
				},
			});
		}

		const history = getRuntimeStreamStore().opsMetricsHistory;
		// Buffer is capped, the oldest samples are dropped, and the newest sample
		// is retained at the tail (oldest → newest ordering).
		expect(history).toHaveLength(OPS_METRICS_HISTORY_LIMIT);
		expect(history[0]?.cpuPercent).toBe(sampleCount - OPS_METRICS_HISTORY_LIMIT);
		expect(history[history.length - 1]?.cpuPercent).toBe(sampleCount - 1);
		// The instantaneous slice tracks the latest sample too.
		expect(getRuntimeStreamStore().opsMetrics?.cpuPercent).toBe(sampleCount - 1);
	});

	it("resets ops-metrics history on a workspace switch", () => {
		dispatchRuntimeStreamAction({
			type: "runtime_metrics_updated",
			payload: { type: "runtime_metrics_updated", metrics: opsMetrics },
		});
		expect(getRuntimeStreamStore().opsMetricsHistory).toHaveLength(1);

		dispatchRuntimeStreamAction({ type: "requested_workspace_changed" });
		expect(getRuntimeStreamStore().opsMetricsHistory).toEqual([]);
	});

	it("resets ops-metrics history on a fresh snapshot but keeps the instantaneous value", () => {
		dispatchRuntimeStreamAction({
			type: "runtime_metrics_updated",
			payload: { type: "runtime_metrics_updated", metrics: opsMetrics },
		});
		expect(getRuntimeStreamStore().opsMetricsHistory).toHaveLength(1);

		dispatchRuntimeStreamAction({
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "ws",
				projects: [],
				workspaceState: null,
				workspaceMetadata: null,
				kanbanSessionContextVersion: 0,
			},
		});

		// History is cleared (fresh connection) but the last instantaneous sample
		// is preserved so the status bar's numbers don't blank out.
		expect(getRuntimeStreamStore().opsMetricsHistory).toEqual([]);
		expect(getRuntimeStreamStore().opsMetrics).toEqual(opsMetrics);
	});

	it("coalesces duplicate chat-message broadcasts (no spurious re-render)", () => {
		let chatRenders = 0;
		function Harness(): null {
			useTaskChatMessages("task-a");
			chatRenders += 1;
			return null;
		}
		act(() => {
			root.render(<Harness />);
		});

		const message = makeMessage("m1", "stable");
		act(() => {
			dispatchRuntimeStreamAction({
				type: "task_chat_message",
				payload: { type: "task_chat_message", workspaceId: "ws", taskId: "task-a", message },
			});
		});
		const afterFirst = chatRenders;

		// Re-broadcasting an identical message must not grow the array or re-render.
		act(() => {
			dispatchRuntimeStreamAction({
				type: "task_chat_message",
				payload: {
					type: "task_chat_message",
					workspaceId: "ws",
					taskId: "task-a",
					message: makeMessage("m1", "stable"),
				},
			});
		});
		expect(chatRenders).toBe(afterFirst);
		expect(getRuntimeStreamStore().taskChatMessagesByTaskId["task-a"]).toHaveLength(1);
	});

	it("caps the per-task live transcript and keeps the newest messages", () => {
		const total = TASK_CHAT_MESSAGE_LIMIT + 50;
		for (let i = 0; i < total; i += 1) {
			dispatchRuntimeStreamAction({
				type: "task_chat_message",
				payload: {
					type: "task_chat_message",
					workspaceId: "ws",
					taskId: "task-a",
					message: makeMessage(`m${i}`, `content-${i}`),
				},
			});
		}

		const messages = getRuntimeStreamStore().taskChatMessagesByTaskId["task-a"] ?? [];
		expect(messages).toHaveLength(TASK_CHAT_MESSAGE_LIMIT);
		// Oldest dropped, newest retained at the tail.
		expect(messages[0]?.id).toBe(`m${total - TASK_CHAT_MESSAGE_LIMIT}`);
		expect(messages[messages.length - 1]?.id).toBe(`m${total - 1}`);
	});

	it("evicts chat buffers for tasks gone from the board and clears latest when it pointed at one", () => {
		dispatchRuntimeStreamAction({
			type: "workspace_state_updated",
			workspaceState: makeWorkspaceState(["task-a", "task-b"]),
		});
		sendChat("task-a", "a1");
		sendChat("task-b", "b1");
		expect(getRuntimeStreamStore().latestTaskChatMessage?.taskId).toBe("task-b");

		// task-b is hard-deleted (absent from the next board).
		dispatchRuntimeStreamAction({ type: "workspace_state_updated", workspaceState: makeWorkspaceState(["task-a"]) });

		const store = getRuntimeStreamStore();
		expect(store.taskChatMessagesByTaskId["task-b"]).toBeUndefined();
		expect(store.taskChatMessagesByTaskId["task-a"]).toHaveLength(1);
		// `latestTaskChatMessage` pointed at the evicted task, so it is cleared.
		expect(store.latestTaskChatMessage).toBeNull();
	});

	it("never evicts synthetic home-chat ids on a board update (they are not board cards)", () => {
		const homeId = "__home_agent__:ws:pi";
		dispatchRuntimeStreamAction({ type: "workspace_state_updated", workspaceState: makeWorkspaceState(["task-a"]) });
		sendChat(homeId, "h1");
		sendChat("task-a", "a1");

		// task-a leaves the board entirely; the home thread must survive.
		dispatchRuntimeStreamAction({ type: "workspace_state_updated", workspaceState: makeWorkspaceState([]) });

		const store = getRuntimeStreamStore();
		expect(store.taskChatMessagesByTaskId["task-a"]).toBeUndefined();
		expect(store.taskChatMessagesByTaskId[homeId]).toHaveLength(1);
	});

	it("keeps the same chat map reference when a board update removes nothing", () => {
		dispatchRuntimeStreamAction({ type: "workspace_state_updated", workspaceState: makeWorkspaceState(["task-a"]) });
		sendChat("task-a", "a1");
		const before = getRuntimeStreamStore().taskChatMessagesByTaskId;

		// A board update that only adds a task must not churn the chat map.
		dispatchRuntimeStreamAction({
			type: "workspace_state_updated",
			workspaceState: makeWorkspaceState(["task-a", "task-c"]),
		});
		expect(getRuntimeStreamStore().taskChatMessagesByTaskId).toBe(before);
	});
});
