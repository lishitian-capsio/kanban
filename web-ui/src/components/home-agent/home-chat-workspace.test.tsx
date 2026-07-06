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

// The single Pi area (PiConversationSurface) subscribes the runtime store + mounts the chat
// panel; stub it so this suite covers the Pi tab wiring, not the Pi surface internals.
vi.mock("@/components/home-agent/pi-conversation-surface", () => ({
	PiConversationSurface: ({ orientation }: { orientation: string }) => (
		<div data-testid="pi-surface">pi-surface:{orientation}</div>
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
		bindThreadImChannel: vi.fn(),
		unbindThreadImChannel: vi.fn(),
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

interface RenderOptions {
	currentProjectId?: string | null;
	homeThreads: UseHomeThreadsResult;
	taskSessions?: Record<string, RuntimeTaskSessionSummary>;
	fullscreenChatTab?: string | null;
	onNavigateFullscreenTab?: (tab: string) => void;
	onReplaceFullscreenTab?: (tab: string) => void;
}

describe("HomeChatWorkspace", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let previousScrollIntoView: typeof Element.prototype.scrollIntoView | undefined;

	function render(options: RenderOptions): void {
		act(() => {
			root.render(
				<HomeChatWorkspace
					currentProjectId={options.currentProjectId === undefined ? WORKSPACE_ID : options.currentProjectId}
					runtimeProjectConfig={RUNTIME_CONFIG}
					homeThreads={options.homeThreads}
					taskSessions={options.taskSessions ?? {}}
					workspaceGit={null}
					threadTaskActions={{
						onStartTask: vi.fn(),
						onMoveTaskToDone: vi.fn(),
						onDeleteTask: vi.fn(),
						onOpenTask: vi.fn(),
						onRestoreTask: vi.fn(),
						onCreateDependency: vi.fn(),
						onDeleteDependency: vi.fn(),
						onSetAutoReview: vi.fn(),
					}}
					fullscreenChatTab={options.fullscreenChatTab ?? "home"}
					onNavigateFullscreenTab={options.onNavigateFullscreenTab ?? vi.fn()}
					onReplaceFullscreenTab={options.onReplaceFullscreenTab ?? vi.fn()}
				/>,
			);
		});
	}

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

	it("shows the Home tab launcher (cards + add card) when the active tab is Home", () => {
		const threads = [
			// The synthetic default thread is retired from the fullscreen launcher; only real
			// (created) threads get a card.
			makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true),
			makeThread("thread-2", "Refactor auth", "claude", false),
		];
		const secondTaskId = createHomeAgentSessionId(WORKSPACE_ID, "claude", "thread-2");

		render({
			homeThreads: makeHomeThreads(threads),
			taskSessions: {
				// Idle so the card shows its message preview (for non-idle sessions the
				// live-activity line takes precedence over the preview).
				[secondTaskId]: makeSummary(secondTaskId, "idle"),
			},
			fullscreenChatTab: "home",
		});

		expect(container.textContent).toContain("Refactor auth");
		expect(container.textContent).toContain("hello from the agent");
		// The synthetic default thread is not a launcher card.
		expect(container.querySelector('[aria-label="Open Default session"]')).toBeNull();
		expect(container.querySelector('[aria-label="New chat session"]')).not.toBeNull();
		// The Home tab is present in the strip and selected.
		const homeTab = container.querySelector('[role="tab"][aria-selected="true"]');
		expect(homeTab?.textContent).toContain("Home");
		// No conversation while on the Home tab.
		expect(container.querySelector('[data-testid="conversation"]')).toBeNull();
	});

	it("opens the clicked card as a session tab (registry openSessionTab + URL navigate)", () => {
		const openSessionTab = vi.fn();
		const onNavigateFullscreenTab = vi.fn();
		const threads = [
			makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true),
			makeThread("thread-2", "Refactor auth", "claude", false),
		];
		render({
			homeThreads: makeHomeThreads(threads, { openSessionTab }),
			onNavigateFullscreenTab,
		});
		const card = container.querySelector('[aria-label="Open Refactor auth session"]') as HTMLButtonElement;
		act(() => {
			card.click();
		});
		expect(openSessionTab).toHaveBeenCalledWith("thread-2");
		expect(onNavigateFullscreenTab).toHaveBeenCalledWith("thread-2");
	});

	it("hard-deletes a non-default session from its launcher card (same closeThread path as compact)", () => {
		const closeThread = vi.fn();
		const threads = [
			makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true),
			makeThread("thread-2", "Refactor auth", "claude", false),
		];
		render({ homeThreads: makeHomeThreads(threads, { closeThread }) });
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

	it("does not render the retired synthetic default thread as a launcher card", () => {
		const threads = [
			makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true),
			makeThread("thread-2", "Refactor auth", "claude", false),
		];
		render({ homeThreads: makeHomeThreads(threads) });
		// The default thread has neither a card nor a (close/open) affordance in fullscreen.
		expect(container.querySelector('[aria-label="Open Default session"]')).toBeNull();
		expect(container.querySelector('[aria-label="Close Default session"]')).toBeNull();
		// Real threads still render.
		expect(container.querySelector('[aria-label="Open Refactor auth session"]')).not.toBeNull();
	});

	it("reconciles the persisted tab set once on mount (entering fullscreen)", () => {
		const reconcileFullscreenTabsOnEnter = vi.fn();
		render({
			homeThreads: makeHomeThreads([makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true)], {
				reconcileFullscreenTabsOnEnter,
			}),
		});
		expect(reconcileFullscreenTabsOnEnter).toHaveBeenCalledTimes(1);
	});

	it("renders the active session tab's conversation named by the URL tab", () => {
		const threads = [
			makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true),
			makeThread("thread-2", "Refactor auth", "claude", false),
		];
		render({
			homeThreads: makeHomeThreads(threads, {
				fullscreenTabs: { openThreadIds: ["thread-2"], activeThreadId: "thread-2" },
			}),
			fullscreenChatTab: "thread-2",
		});
		// Conversation for the active tab shows; the launcher add-card is gone.
		expect(container.querySelector('[data-testid="conversation"]')?.textContent).toBe("conversation:thread-2");
		expect(container.querySelector('[aria-label="New chat session"]')).toBeNull();
		// The open session tab is in the strip and selected.
		const activeTab = container.querySelector('[role="tab"][aria-selected="true"]');
		expect(activeTab?.textContent).toContain("Refactor auth");
	});

	it("activating a tab routes through the URL (onNavigateFullscreenTab)", () => {
		const onNavigateFullscreenTab = vi.fn();
		const threads = [makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true)];
		render({ homeThreads: makeHomeThreads(threads), fullscreenChatTab: "home", onNavigateFullscreenTab });
		const piTab = [...container.querySelectorAll('[role="tab"]')].find(
			(tab) => tab.textContent === "Pi",
		) as HTMLButtonElement;
		act(() => {
			piTab.click();
		});
		expect(onNavigateFullscreenTab).toHaveBeenCalledWith("pi");
	});

	it("falls back to Home in place when the URL names a session that no longer exists", () => {
		const onReplaceFullscreenTab = vi.fn();
		const threads = [makeThread(DEFAULT_HOME_THREAD_ID, "Default", "pi", true)];
		render({ homeThreads: makeHomeThreads(threads), fullscreenChatTab: "thread-gone", onReplaceFullscreenTab });
		expect(onReplaceFullscreenTab).toHaveBeenCalledWith("home");
	});

	it("renders the single Pi conversation surface when the Pi tab is active (decision 647ea / X1)", () => {
		// Pi is one embedded area, not a switchable multi-session workspace. Whatever threads
		// exist, the Pi tab shows exactly one Pi surface — no session rail, no launcher add-card.
		const threads = [
			makeThread(DEFAULT_HOME_THREAD_ID, "Default", "claude", true),
			makeThread("claude-1", "Other agent", "claude", false),
		];
		render({ homeThreads: makeHomeThreads(threads), fullscreenChatTab: "pi" });
		const piTab = [...container.querySelectorAll('[role="tab"]')].find(
			(tab) => tab.textContent === "Pi",
		) as HTMLButtonElement;
		expect(piTab.getAttribute("aria-selected")).toBe("true");
		expect(container.querySelector('[data-testid="pi-surface"]')?.textContent).toBe("pi-surface:fullscreen");
		// No CLI conversation body and no launcher add-card while the Pi tab is active.
		expect(container.querySelector('[data-testid="conversation"]')).toBeNull();
		expect(container.querySelector('[aria-label="New chat session"]')).toBeNull();
	});

	it("renders nothing without a project or config", () => {
		render({ currentProjectId: null, homeThreads: makeHomeThreads([]) });
		expect(container.textContent).toBe("");
	});
});
