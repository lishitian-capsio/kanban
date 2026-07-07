import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigResponse, RuntimeTaskSessionSummary, RuntimeTaskSubagent } from "@/runtime/types";

// The chat panel pulls in the composer/virtuoso/session machinery; stub it so this
// suite covers the surface wiring (which task id it binds, drill-in, read-only), not
// the panel internals.
const chatPanelSpy = vi.hoisted(() => vi.fn());
vi.mock("@/components/detail-panels/kanban-agent-chat-panel", () => ({
	KanbanAgentChatPanel: (props: { taskId: string; readOnly?: boolean }) => {
		chatPanelSpy(props);
		return (
			<div data-testid="chat-panel" data-task-id={props.taskId} data-readonly={String(props.readOnly ?? false)}>
				chat:{props.taskId}
			</div>
		);
	},
}));

vi.mock("@/components/agent-providers/session-provider-control", () => ({
	SessionProviderControl: () => <div data-testid="provider-control" />,
}));

vi.mock("@/hooks/use-kanban-chat-runtime-actions", () => ({
	useKanbanChatRuntimeActions: () => ({
		sendTaskChatMessage: vi.fn(),
		loadTaskChatMessages: vi.fn(),
		cancelTaskChatTurn: vi.fn(),
		abortTaskChatTurn: vi.fn(),
	}),
}));

vi.mock("@/hooks/use-reload-pi-session-on-context-bump", () => ({
	useReloadPiSessionOnContextBump: vi.fn(),
}));

vi.mock("@/hooks/use-pi-im-channel", () => ({
	usePiImChannel: () => ({
		imChannel: null,
		isLoading: false,
		refresh: vi.fn(async () => {}),
		bind: vi.fn(async () => true),
		unbind: vi.fn(async () => true),
	}),
}));

const chatMessagesSpy = vi.hoisted(() => vi.fn());
let parentSummary: RuntimeTaskSessionSummary | null = null;
vi.mock("@/runtime/runtime-stream-store", () => ({
	useRuntimeKanbanSessionContextVersion: () => 0,
	useTaskSessionSummary: (taskId: string | null) => (taskId === PARENT_ID ? parentSummary : null),
	useTaskChatMessages: (taskId: string | null) => {
		chatMessagesSpy(taskId);
		return null;
	},
	useLatestTaskChatMessageForTask: () => null,
}));

import { PiConversationSurface } from "@/components/home-agent/pi-conversation-surface";

const WORKSPACE_ID = "ws1";
const PARENT_ID = createHomeAgentSessionId(WORKSPACE_ID, "pi");

const RUNTIME_CONFIG = {
	selectedAgentId: "claude",
	agents: [{ id: "pi", label: "Kanban", binary: "", command: "", defaultArgs: [], installed: true, configured: true }],
} as unknown as RuntimeConfigResponse;

function makeSummary(subagents: RuntimeTaskSubagent[] | null): RuntimeTaskSessionSummary {
	return {
		taskId: PARENT_ID,
		state: "running",
		agentId: "pi",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		subagents,
	};
}

const SUBAGENT: RuntimeTaskSubagent = {
	subagentId: "sub-1",
	parentTaskId: PARENT_ID,
	sessionId: "pi-sub#composite#sub-1",
	label: "Investigate flaky test",
	status: "running",
	modelId: null,
	usage: null,
	startedAt: 0,
	updatedAt: 0,
};

describe("PiConversationSurface", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		chatPanelSpy.mockReset();
		chatMessagesSpy.mockReset();
		parentSummary = null;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(): void {
		act(() => {
			root.render(
				<PiConversationSurface
					currentProjectId={WORKSPACE_ID}
					runtimeProjectConfig={RUNTIME_CONFIG}
					workspaceGit={null}
					orientation="fullscreen"
				/>,
			);
		});
	}

	it("binds the transcript to the stable per-workspace Pi id (main view, not read-only)", () => {
		parentSummary = makeSummary(null);
		render();
		const panel = container.querySelector('[data-testid="chat-panel"]');
		expect(panel?.getAttribute("data-task-id")).toBe(PARENT_ID);
		expect(panel?.getAttribute("data-readonly")).toBe("false");
		// Only one chat subscription is opened (the active task id).
		expect(chatMessagesSpy).toHaveBeenCalledWith(PARENT_ID);
		expect(new Set(chatMessagesSpy.mock.calls.map((c) => c[0])).size).toBe(1);
	});

	it("drilling into a subagent swaps the transcript to the subagent session id and is read-only", () => {
		parentSummary = makeSummary([SUBAGENT]);
		render();
		// Click the subagent row in the rail.
		const subRow = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Investigate"),
		) as HTMLButtonElement;
		act(() => subRow.click());
		const panel = container.querySelector('[data-testid="chat-panel"]');
		expect(panel?.getAttribute("data-task-id")).toBe(SUBAGENT.sessionId);
		expect(panel?.getAttribute("data-readonly")).toBe("true");
		// The active chat subscription followed to the subagent id (still one active at a time).
		expect(chatMessagesSpy).toHaveBeenCalledWith(SUBAGENT.sessionId);
	});
});
