import { createHomeAgentSessionId, DEFAULT_HOME_THREAD_ID } from "@runtime-home-agent-session";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FullscreenTabsState } from "@/components/home-agent/home-fullscreen-tabs";
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

// The active-tab conversation pulls in the session machinery (runtime store, terminal,
// provider control); stub it so this suite covers tab/launcher switching, not the chat body.
vi.mock("@/components/home-agent/home-agent-conversation", () => ({
	HomeAgentConversation: ({ activeThread }: { activeThread: HomeThread | null }) => (
		<div data-testid="conversation">conversation:{activeThread?.id ?? "none"}</div>
	),
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

const EMPTY_TABS: FullscreenTabsState = { openThreadIds: [], activeThreadId: null };

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
		fullscreenTabs: EMPTY_TABS,
		openSessionTab: vi.fn(),
		closeSessionTab: vi.fn(),
		activateSessionTab: vi.fn(),
		activateHomeTab: vi.fn(),
		reconcileFullscreenTabsOnEnter: vi.fn(),
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

describe("HomeChatWorkspace", () => {
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

	it("shows the Home tab launcher (cards + add card) when no session tab is active", () => {
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
					workspaceGit={null}
				/>,
			);
		});

		expect(container.textContent).toContain("Refactor auth");
		expect(container.textContent).toContain("hello from the agent");
		expect(container.querySelector('[aria-label="New chat session"]')).not.toBeNull();
		// The Home tab is present in the strip and selected.
		const homeTab = container.querySelector('[role="tab"][aria-selected="true"]');
		expect(homeTab?.textContent).toContain("Home");
		// No conversation while on the Home tab.
		expect(container.querySelector('[data-testid="conversation"]')).toBeNull();
	});

	it("opens the clicked card as a session tab (onOpenSession → openSessionTab)", () => {
		const openSessionTab = vi.fn();
		const threads = [makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true)];
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={WORKSPACE_ID}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads(threads, { openSessionTab })}
					taskSessions={{}}
					workspaceGit={null}
				/>,
			);
		});
		const card = container.querySelector('[aria-label="Open Default session"]') as HTMLButtonElement;
		act(() => {
			card.click();
		});
		expect(openSessionTab).toHaveBeenCalledWith(DEFAULT_HOME_THREAD_ID);
	});

	it("reconciles the persisted tab set once on mount (entering fullscreen)", () => {
		const reconcileFullscreenTabsOnEnter = vi.fn();
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={WORKSPACE_ID}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads([makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true)], {
						reconcileFullscreenTabsOnEnter,
					})}
					taskSessions={{}}
					workspaceGit={null}
				/>,
			);
		});
		expect(reconcileFullscreenTabsOnEnter).toHaveBeenCalledTimes(1);
	});

	it("renders the active session tab's conversation instead of the launcher", () => {
		const threads = [
			makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true),
			makeThread("thread-2", "Refactor auth", "claude", false),
		];
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={WORKSPACE_ID}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads(threads, {
						fullscreenTabs: { openThreadIds: ["thread-2"], activeThreadId: "thread-2" },
					})}
					taskSessions={{}}
					workspaceGit={null}
				/>,
			);
		});
		// Conversation for the active tab shows; the launcher add-card is gone.
		expect(container.querySelector('[data-testid="conversation"]')?.textContent).toBe("conversation:thread-2");
		expect(container.querySelector('[aria-label="New chat session"]')).toBeNull();
		// The open session tab is in the strip and selected.
		const activeTab = container.querySelector('[role="tab"][aria-selected="true"]');
		expect(activeTab?.textContent).toContain("Refactor auth");
	});

	it("renders nothing without a project or config", () => {
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={null}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads([])}
					taskSessions={{}}
					workspaceGit={null}
				/>,
			);
		});
		expect(container.textContent).toBe("");
	});
});
