import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentDefinition, RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "@/runtime/types";

// The per-card data hook hits the runtime store + tRPC; stub it so the card test
// exercises presentation + the affordance wiring, not network/streaming.
vi.mock("@/hooks/use-home-session-card", () => ({
	useHomeSessionCard: (_projectId: string | null, taskId: string | null) => ({
		preview: taskId ? { role: "assistant" as const, text: "hello from the agent", createdAt: 10 } : null,
		isLoadingHistory: false,
	}),
}));

import { HomeSessionCard } from "@/components/home-agent/home-session-card";

const WORKSPACE_ID = "ws1";
const TASK_ID = "__home_agent__:ws1:claude:thread-2";

const AGENTS = [
	{ id: "pi", label: "Kanban", binary: "", command: "", defaultArgs: [], installed: true, configured: true },
	{ id: "claude", label: "Claude", binary: "", command: "", defaultArgs: [], installed: true, configured: true },
] as unknown as RuntimeAgentDefinition[];

function makeThread(overrides: Partial<HomeThread> = {}): HomeThread {
	return {
		id: "thread-2",
		agentId: "claude",
		name: "Refactor auth",
		titleSource: "manual",
		createdAt: 0,
		updatedAt: 0,
		isDefault: false,
		...overrides,
	};
}

function makeSummary(
	state: RuntimeTaskSessionState,
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId: TASK_ID,
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
		...overrides,
	};
}

const CREDIT_LIMIT_ACTIVITY: RuntimeTaskSessionSummary["latestHookActivity"] = {
	activityText: "Out of credits",
	toolName: null,
	toolInputSummary: null,
	finalMessage: null,
	hookEventName: "notification",
	notificationType: "credit_limit",
	source: "pi",
};

interface RenderOptions {
	thread?: HomeThread;
	summary?: RuntimeTaskSessionSummary | null;
	isOpen?: boolean;
	onOpenSession?: (threadId: string) => void;
	onRename?: (threadId: string, name: string) => void | Promise<void>;
	onClose?: (threadId: string) => void | Promise<void>;
	onRestart?: (threadId: string) => void | Promise<void>;
}

describe("HomeSessionCard", () => {
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

	function renderCard(options: RenderOptions = {}) {
		const thread = options.thread ?? makeThread();
		act(() => {
			root.render(
				<HomeSessionCard
					thread={thread}
					taskId={TASK_ID}
					agents={AGENTS}
					summary={options.summary ?? makeSummary("idle")}
					isOpen={options.isOpen ?? false}
					currentProjectId={WORKSPACE_ID}
					onOpenSession={options.onOpenSession ?? vi.fn()}
					onRename={options.onRename ?? vi.fn()}
					onClose={options.onClose ?? vi.fn()}
					onRestart={options.onRestart ?? vi.fn()}
				/>,
			);
		});
		return thread;
	}

	function byAriaLabel<T extends HTMLElement = HTMLElement>(label: string): T | null {
		return container.querySelector<T>(`[aria-label="${label}"]`);
	}

	function setInputValue(input: HTMLInputElement, value: string) {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, value);
		act(() => {
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	it("keeps the MVP layout (name, preview, agent icon, status dot) when idle", () => {
		// Idle: the body falls back to the last conversational line (no live activity).
		renderCard({ summary: makeSummary("idle") });
		expect(container.textContent).toContain("Refactor auth");
		expect(container.textContent).toContain("hello from the agent");
		// The agent identity is now a hover-named icon (no repeated text label); its
		// accessible name surfaces the full agent name.
		expect(byAriaLabel("Claude")).not.toBeNull();
		expect(byAriaLabel("Idle")).not.toBeNull();
	});

	it("shows the live agent-activity line instead of the preview while running", () => {
		// A running session with no hook detail derives a generic "Thinking..." line;
		// the colored-dot activity row replaces the last-message preview.
		renderCard({ summary: makeSummary("running") });
		expect(byAriaLabel("Running")).not.toBeNull();
		expect(byAriaLabel("Agent activity")).not.toBeNull();
		expect(container.textContent).toContain("Thinking...");
		expect(container.textContent).not.toContain("hello from the agent");
	});

	it("renders a spinner status marker while running (mirrors the board task card)", () => {
		renderCard({ summary: makeSummary("running") });
		const marker = byAriaLabel("Running");
		expect(marker?.querySelector("svg.animate-spin")).not.toBeNull();
	});

	it("renders a red alert-circle status marker when failed/interrupted", () => {
		renderCard({ summary: makeSummary("failed") });
		const marker = byAriaLabel("Failed");
		expect(marker).not.toBeNull();
		expect(marker?.querySelector("svg.text-status-red")).not.toBeNull();
	});

	it("renders an orange alert-triangle 'Out of credits' marker on a credit-limit error", () => {
		renderCard({ summary: makeSummary("failed", { latestHookActivity: CREDIT_LIMIT_ACTIVITY }) });
		const marker = byAriaLabel("Out of credits");
		expect(marker).not.toBeNull();
		expect(marker?.querySelector("svg.text-status-orange")).not.toBeNull();
	});

	it("surfaces a derived tool-call label as the live activity text", () => {
		const summary = makeSummary("running");
		renderCard({
			summary: {
				...summary,
				latestHookActivity: {
					activityText: "Using Read",
					toolName: "Read",
					toolInputSummary: "src/index.ts",
					finalMessage: null,
					hookEventName: "tool_call",
					notificationType: null,
					source: "pi",
				},
			},
		});
		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Using Read");
	});

	it("reads awaiting_review as idle: shows the message preview, never a 'Waiting for review' live row", () => {
		// Home chat has no review concept. A finished turn (awaiting_review) means
		// "your turn" — the card must stay calm: no live-activity row, no spinner, no
		// "Waiting for review"; just the quiet status dot + the last message preview.
		renderCard({ summary: makeSummary("awaiting_review") });
		expect(byAriaLabel("Agent activity")).toBeNull();
		expect(container.textContent).not.toContain("Waiting for review");
		expect(container.textContent).not.toContain("Thinking...");
		expect(container.textContent).toContain("hello from the agent");
	});

	it("opens the session when the card body is clicked", () => {
		const onOpenSession = vi.fn();
		renderCard({ onOpenSession });
		const card = byAriaLabel<HTMLDivElement>("Open Refactor auth session");
		act(() => {
			card?.click();
		});
		expect(onOpenSession).toHaveBeenCalledWith("thread-2");
	});

	it("enters inline rename on the pencil and submits the new name on blur", () => {
		const onRename = vi.fn();
		const onOpenSession = vi.fn();
		renderCard({ onRename, onOpenSession });
		const pencil = byAriaLabel<HTMLButtonElement>("Rename Refactor auth session");
		expect(pencil).not.toBeNull();
		act(() => {
			pencil?.click();
		});
		// The pencil click must not bubble to the card and open the session.
		expect(onOpenSession).not.toHaveBeenCalled();
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input).not.toBeNull();
		setInputValue(input, "Renamed thread");
		act(() => {
			input.dispatchEvent(new Event("focusout", { bubbles: true }));
		});
		expect(onRename).toHaveBeenCalledWith("thread-2", "Renamed thread");
	});

	it("cancels inline rename on Escape without calling onRename", () => {
		const onRename = vi.fn();
		renderCard({ onRename });
		act(() => {
			byAriaLabel<HTMLButtonElement>("Rename Refactor auth session")?.click();
		});
		const input = container.querySelector("input") as HTMLInputElement;
		setInputValue(input, "Throwaway");
		act(() => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		// The input collapses back to the static name and nothing is saved.
		expect(container.querySelector("input")).toBeNull();
		expect(onRename).not.toHaveBeenCalled();
	});

	it("confirms before closing and routes the confirm to onClose", () => {
		const onClose = vi.fn();
		const onOpenSession = vi.fn();
		renderCard({ onClose, onOpenSession });
		const closeButton = byAriaLabel<HTMLButtonElement>("Close Refactor auth session");
		expect(closeButton).not.toBeNull();
		act(() => {
			closeButton?.click();
		});
		expect(onOpenSession).not.toHaveBeenCalled();
		// The destructive confirm dialog (portaled to the body) gates the close.
		const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
			(button.textContent ?? "").includes("Close thread"),
		) as HTMLButtonElement | undefined;
		expect(confirm).toBeDefined();
		act(() => {
			confirm?.click();
		});
		expect(onClose).toHaveBeenCalledWith("thread-2");
	});

	it("hides rename and close affordances for the default thread", () => {
		renderCard({ thread: makeThread({ id: "default", name: "Default", isDefault: true }) });
		expect(byAriaLabel("Rename Default session")).toBeNull();
		expect(byAriaLabel("Close Default session")).toBeNull();
	});

	it("applies an accent 'already open' highlight when the thread is open in a tab", () => {
		renderCard({ isOpen: true });
		const card = byAriaLabel<HTMLDivElement>("Open Refactor auth session");
		expect(card?.dataset.open).toBe("true");
		expect(card?.className).toContain("border-accent");
	});

	it("uses the resting border (no accent highlight) when the thread is not open", () => {
		renderCard({ isOpen: false });
		const card = byAriaLabel<HTMLDivElement>("Open Refactor auth session");
		expect(card?.dataset.open).toBe("false");
		expect(card?.className).not.toContain("border-accent");
	});

	it("shows a restart action only when the session is in an error state", () => {
		const onRestart = vi.fn();
		renderCard({ summary: makeSummary("running"), onRestart });
		expect(byAriaLabel("Restart Refactor auth session")).toBeNull();

		renderCard({ summary: makeSummary("failed"), onRestart });
		const restart = byAriaLabel<HTMLButtonElement>("Restart Refactor auth session");
		expect(restart).not.toBeNull();
		act(() => {
			restart?.click();
		});
		expect(onRestart).toHaveBeenCalledWith("thread-2");
	});
});
