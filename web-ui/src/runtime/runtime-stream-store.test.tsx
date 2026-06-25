import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	dispatchRuntimeStreamAction,
	getRuntimeStreamStore,
	resetRuntimeStreamStoreForTest,
	useRuntimeBoardSyncStatus,
	useRuntimeOpsMetrics,
	useRuntimeProjects,
	useTaskChatMessages,
} from "@/runtime/runtime-stream-store";
import type { RuntimeBoardSyncStatus, RuntimeOpsMetrics, RuntimeTaskChatMessage } from "@/runtime/types";

function makeMessage(id: string, content: string): RuntimeTaskChatMessage {
	return { id, role: "assistant", content, createdAt: 1 };
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
});
