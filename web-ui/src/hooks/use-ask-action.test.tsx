import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_KANBAN_ASK_ITERATIONS, resetKanbanAsk } from "@/git-actions/ask-guardrail";
import { type UseAskActionInput, type UseAskActionResult, useAskAction } from "@/hooks/use-ask-action";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { BoardCard, BoardData } from "@/types";

vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));

function card(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "t1",
		title: "Task one",
		prompt: "Implement the thing",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function board(cards: BoardCard[]): BoardData {
	return { columns: [{ id: "review", title: "Review", cards }], dependencies: [] };
}

const TASK_ID = "t1";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function renderAskAction(overrides: Partial<UseAskActionInput> = {}): Promise<{
	getResult: () => UseAskActionResult;
	deps: {
		sendTaskChatMessage: ReturnType<typeof vi.fn>;
		sendTaskSessionInput: ReturnType<typeof vi.fn>;
		createHomeThread: ReturnType<typeof vi.fn>;
	};
	cleanup: () => void;
}> {
	const sendTaskChatMessage = vi.fn(async () => ({ ok: true }));
	const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
	const thread: HomeThread = {
		id: "thread-1",
		agentId: "pi",
		name: "Ask",
		createdAt: 0,
		updatedAt: 0,
		isDefault: false,
	};
	const createHomeThread = vi.fn(async () => thread);

	let result: UseAskActionResult | null = null;
	function Harness(): null {
		result = useAskAction({
			currentProjectId: "ws1",
			board: board([card()]),
			taskSessions: {
				[TASK_ID]: {
					taskId: TASK_ID,
					state: "awaiting_review",
					agentId: "pi",
					workspacePath: "/wt/t1",
					latestHookActivity: { finalMessage: "Approach A or B?" },
				} as never,
			},
			runtimeProjectConfig: null,
			sendTaskChatMessage,
			sendTaskSessionInput,
			createHomeThread,
			...overrides,
		});
		return null;
	}

	const container = document.createElement("div");
	let root: Root;
	await act(async () => {
		root = createRoot(container);
		root.render(<Harness />);
	});

	return {
		getResult: () => result!,
		deps: { sendTaskChatMessage, sendTaskSessionInput, createHomeThread },
		cleanup: () => act(() => root.unmount()),
	};
}

describe("useAskAction", () => {
	beforeEach(() => {
		resetKanbanAsk(TASK_ID);
	});
	afterEach(() => {
		resetKanbanAsk(TASK_ID);
	});

	it("ask-self injects the question into the task's own (native) chat session", async () => {
		const { getResult, deps, cleanup } = await renderAskAction();
		await act(async () => {
			getResult().handleAskSelf(TASK_ID);
			await flush();
		});

		expect(deps.sendTaskChatMessage).toHaveBeenCalledTimes(1);
		const [targetId, prompt, options] = deps.sendTaskChatMessage.mock.calls[0]!;
		expect(targetId).toBe(TASK_ID);
		expect(prompt).toContain("> Approach A or B?");
		expect(options).toEqual({ mode: "act" });
		// Ask never creates a thread or moves the task — it only injects.
		expect(deps.createHomeThread).not.toHaveBeenCalled();
		cleanup();
	});

	it("ask-kanban creates a kanban-agent thread and injects task context there", async () => {
		const { getResult, deps, cleanup } = await renderAskAction();
		await act(async () => {
			getResult().handleAskKanbanAgent(TASK_ID);
			await flush();
		});

		expect(deps.createHomeThread).toHaveBeenCalledTimes(1);
		expect(deps.createHomeThread.mock.calls[0]![0]).toMatchObject({ agentId: "pi" });
		// Injected into the synthetic home session id for that thread, not the task.
		const [targetId, prompt] = deps.sendTaskChatMessage.mock.calls[0]!;
		expect(targetId).toContain("__home_agent__:ws1:pi:thread-1");
		expect(prompt).toContain("Task one (t1)");
		expect(prompt).toContain("> Approach A or B?");
		cleanup();
	});

	it("reuses one kanban thread across repeated asks for the same task", async () => {
		const { getResult, deps, cleanup } = await renderAskAction();
		await act(async () => {
			getResult().handleAskKanbanAgent(TASK_ID);
			await flush();
			getResult().handleAskKanbanAgent(TASK_ID);
			await flush();
		});
		expect(deps.createHomeThread).toHaveBeenCalledTimes(1);
		cleanup();
	});

	it("guardrail blocks ask-kanban past the iteration cap (no infinite loop)", async () => {
		const { getResult, deps, cleanup } = await renderAskAction();
		for (let i = 0; i < MAX_KANBAN_ASK_ITERATIONS + 2; i += 1) {
			await act(async () => {
				getResult().handleAskKanbanAgent(TASK_ID);
				await flush();
			});
		}
		// Delivery happens at most MAX times; further asks are refused.
		expect(deps.sendTaskChatMessage.mock.calls.length).toBe(MAX_KANBAN_ASK_ITERATIONS);
		cleanup();
	});
});
