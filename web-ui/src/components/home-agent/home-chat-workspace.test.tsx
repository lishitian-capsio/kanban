import { createHomeAgentSessionId, DEFAULT_HOME_THREAD_ID } from "@runtime-home-agent-session";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeThread, UseHomeThreadsResult } from "@/hooks/use-home-threads";
import type { RuntimeConfigResponse, RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "@/runtime/types";

// The per-card data hook hits the runtime store + tRPC; stub it so the launcher
// test exercises grid composition, not network/streaming.
vi.mock("@/hooks/use-home-session-card", () => ({
	useHomeSessionCard: (_projectId: string | null, taskId: string | null) => ({
		preview: taskId ? { role: "assistant" as const, text: "hello from the agent", createdAt: 10 } : null,
		isLoadingHistory: false,
	}),
}));

import { HomeChatWorkspace } from "@/components/home-agent/home-chat-workspace";

const WORKSPACE_ID = "ws1";

function makeThread(id: string, name: string, agentId: "pi" | "claude", isDefault: boolean): HomeThread {
	return { id, agentId, name, titleSource: "manual", createdAt: 0, updatedAt: 0, isDefault };
}

function makeSummary(taskId: string, state: RuntimeTaskSessionState): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
	};
}

function makeHomeThreads(threads: HomeThread[], overrides: Partial<UseHomeThreadsResult> = {}): UseHomeThreadsResult {
	return {
		threads,
		activeThread: threads[0] ?? null,
		activeThreadId: threads[0]?.id ?? DEFAULT_HOME_THREAD_ID,
		setActiveThread: vi.fn(),
		createThread: vi.fn(),
		renameThread: vi.fn(),
		closeThread: vi.fn(),
		clearNextStep: vi.fn(),
		refresh: vi.fn(),
		isLoading: false,
		...overrides,
	};
}

const RUNTIME_CONFIG = {
	selectedAgentId: "pi",
	agents: [
		{ id: "pi", label: "Kanban", binary: "", command: "", defaultArgs: [], installed: true, configured: true },
		{ id: "claude", label: "Claude", binary: "", command: "", defaultArgs: [], installed: true, configured: true },
	],
} as unknown as RuntimeConfigResponse;

describe("HomeChatWorkspace launcher", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("renders one card per thread, the preview, the status dot, and the add card", () => {
		const threads = [
			makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true),
			makeThread("thread-2", "Refactor auth", "claude", false),
		];
		const defaultTaskId = createHomeAgentSessionId(WORKSPACE_ID, "pi", DEFAULT_HOME_THREAD_ID);
		const secondTaskId = createHomeAgentSessionId(WORKSPACE_ID, "claude", "thread-2");

		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={WORKSPACE_ID}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads(threads)}
					taskSessions={{
						[defaultTaskId]: makeSummary(defaultTaskId, "running"),
						[secondTaskId]: makeSummary(secondTaskId, "awaiting_review"),
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("Default");
		expect(container.textContent).toContain("Refactor auth");
		expect(container.textContent).toContain("hello from the agent");
		// Add-session card is always present.
		const addButton = container.querySelector('[aria-label="New chat session"]');
		expect(addButton).not.toBeNull();
		// Status dots carry their accessible label.
		expect(container.querySelector('[aria-label="Running"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Awaiting review"]')).not.toBeNull();
	});

	it("opens the clicked thread (onOpenSession → setActiveThread)", () => {
		const setActiveThread = vi.fn();
		const threads = [makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true)];
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={WORKSPACE_ID}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads(threads, { setActiveThread })}
					taskSessions={{}}
				/>,
			);
		});
		const card = container.querySelector('[aria-label="Open Default session"]') as HTMLButtonElement;
		act(() => {
			card.click();
		});
		expect(setActiveThread).toHaveBeenCalledWith(DEFAULT_HOME_THREAD_ID);
	});

	it("renders nothing without a project or config", () => {
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={null}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads([])}
					taskSessions={{}}
				/>,
			);
		});
		expect(container.textContent).toBe("");
	});
});
