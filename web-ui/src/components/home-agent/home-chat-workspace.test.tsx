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
	let previousScrollIntoView: typeof Element.prototype.scrollIntoView | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		// jsdom does not implement scrollIntoView; the strip's active-tab auto-scroll effect
		// calls it on mount/tab-switch. Stub it so the effect is a no-op in tests.
		previousScrollIntoView = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = vi.fn();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		Element.prototype.scrollIntoView = previousScrollIntoView ?? vi.fn();
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
						// Idle so the card shows its message preview (for non-idle sessions the
						// live-activity line takes precedence over the preview).
						[defaultTaskId]: makeSummary(defaultTaskId, "idle"),
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

	it("hard-deletes a non-default session from its launcher card (same closeThread path as compact)", () => {
		const closeThread = vi.fn();
		const threads = [
			makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true),
			makeThread("thread-2", "Refactor auth", "claude", false),
		];
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={WORKSPACE_ID}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads(threads, { closeThread })}
					taskSessions={{}}
					workspaceGit={null}
				/>,
			);
		});
		const deleteButton = container.querySelector(
			'[aria-label="Close Refactor auth session"]',
		) as HTMLButtonElement | null;
		expect(deleteButton).not.toBeNull();
		act(() => {
			deleteButton?.click();
		});
		// The destructive-confirm dialog (Radix portal → document.body) mirrors the compact close flow.
		const confirm = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === "Close thread",
		) as HTMLButtonElement | undefined;
		expect(confirm).not.toBeUndefined();
		act(() => {
			confirm?.click();
		});
		expect(closeThread).toHaveBeenCalledWith("thread-2");
	});

	it("does not render a delete affordance on the default session card", () => {
		const threads = [makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true)];
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={WORKSPACE_ID}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads(threads)}
					taskSessions={{}}
					workspaceGit={null}
				/>,
			);
		});
		expect(container.querySelector('[aria-label="Close Default session"]')).toBeNull();
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

	it("opens the Pi tab as a pi-scoped session workspace (base active, non-pi threads excluded)", () => {
		const threads = [
			// The workspace-global default is claude here; the Pi tab still pins its own pi base.
			makeThread(DEFAULT_HOME_THREAD_ID, "Default", "claude", true),
			makeThread("pi-1", "Fix tests", "pi", false),
			makeThread("claude-1", "Other agent", "claude", false),
		];
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={WORKSPACE_ID}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads(threads)}
					taskSessions={{}}
					workspaceGit={null}
				/>,
			);
		});
		const piTab = [...container.querySelectorAll('[role="tab"]')].find(
			(tab) => tab.textContent === "Pi",
		) as HTMLButtonElement;
		act(() => {
			piTab.click();
		});
		expect(piTab.getAttribute("aria-selected")).toBe("true");
		// The base pi session is active in the conversation (legacy default thread id).
		expect(container.querySelector('[data-testid="conversation"]')?.textContent).toBe(
			`conversation:${DEFAULT_HOME_THREAD_ID}`,
		);
		// The rail lists pi sessions only — the created pi thread, never the claude one.
		expect(container.textContent).toContain("Fix tests");
		expect(container.textContent).not.toContain("Other agent");
		// The Home launcher add-card is gone while the Pi tab is active.
		expect(container.querySelector('[aria-label="New chat session"]')).toBeNull();
	});

	it("creates a blank pi session from the Pi tab rail (name-only, no kickoff prompt)", async () => {
		const createThread = vi.fn().mockResolvedValue(null);
		const threads = [makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true)];
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={WORKSPACE_ID}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={makeHomeThreads(threads, { createThread })}
					taskSessions={{}}
					workspaceGit={null}
				/>,
			);
		});
		const piTab = [...container.querySelectorAll('[role="tab"]')].find(
			(tab) => tab.textContent === "Pi",
		) as HTMLButtonElement;
		act(() => {
			piTab.click();
		});
		const newButton = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "New session",
		) as HTMLButtonElement;
		await act(async () => {
			newButton.click();
		});
		expect(createThread).toHaveBeenCalledWith({ name: "New session", agentId: "pi" });
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
