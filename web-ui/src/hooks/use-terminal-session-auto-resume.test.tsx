import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import { useTerminalSessionAutoResume } from "@/hooks/use-terminal-session-auto-resume";
import type { RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { CardSelection } from "@/types/board";

const showAppToastMock = vi.fn();
vi.mock("@/components/app-toaster", () => ({
	showAppToast: (...args: unknown[]) => showAppToastMock(...args),
}));

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "t1",
		state: "idle" as RuntimeTaskSessionState,
		agentId: "claude",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		agentSessionId: "sess-1",
		...overrides,
	} as RuntimeTaskSessionSummary;
}

function makeSelection(taskId: string, columnId: string): CardSelection {
	return {
		card: { id: taskId },
		column: { id: columnId },
		allColumns: [],
	} as unknown as CardSelection;
}

function Harness(props: {
	selectedCard: CardSelection | null;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	enabled: boolean;
}) {
	useTerminalSessionAutoResume(props);
	return null;
}

describe("useTerminalSessionAutoResume", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		showAppToastMock.mockClear();
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("relaunches a dead terminal session exactly once", async () => {
		const startTaskSession = vi.fn().mockResolvedValue({ ok: true });
		const sessions = { t1: makeSummary({ state: "idle", agentId: "claude", agentSessionId: "sess-1" }) };

		await act(async () => {
			root.render(
				<Harness
					selectedCard={makeSelection("t1", "in_progress")}
					sessions={sessions}
					startTaskSession={startTaskSession}
					enabled
				/>,
			);
		});
		// A later session-summary update for the same task must not fire a second launch.
		await act(async () => {
			root.render(
				<Harness
					selectedCard={makeSelection("t1", "in_progress")}
					sessions={{
						t1: makeSummary({ state: "idle", agentId: "claude", agentSessionId: "sess-1", updatedAt: 1 }),
					}}
					startTaskSession={startTaskSession}
					enabled
				/>,
			);
		});

		expect(startTaskSession).toHaveBeenCalledTimes(1);
		expect(startTaskSession).toHaveBeenCalledWith({ id: "t1" }, { reconnect: true });
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("does not relaunch a live session", async () => {
		const startTaskSession = vi.fn().mockResolvedValue({ ok: true });
		await act(async () => {
			root.render(
				<Harness
					selectedCard={makeSelection("t1", "in_progress")}
					sessions={{ t1: makeSummary({ state: "running" }) }}
					startTaskSession={startTaskSession}
					enabled
				/>,
			);
		});
		expect(startTaskSession).not.toHaveBeenCalled();
	});

	it("warns when the agent cannot resume its conversation", async () => {
		const startTaskSession = vi.fn().mockResolvedValue({ ok: true });
		await act(async () => {
			root.render(
				<Harness
					selectedCard={makeSelection("t1", "in_progress")}
					sessions={{ t1: makeSummary({ state: "interrupted", agentId: "gemini", agentSessionId: null }) }}
					startTaskSession={startTaskSession}
					enabled
				/>,
			);
		});
		expect(startTaskSession).toHaveBeenCalledTimes(1);
		expect(showAppToastMock).toHaveBeenCalledTimes(1);
	});

	it("retries on a later open after a failed relaunch", async () => {
		const startTaskSession = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
		const sessions = { t1: makeSummary({ state: "idle" }) };
		// First open → relaunch fails.
		await act(async () => {
			root.render(
				<Harness
					selectedCard={makeSelection("t1", "in_progress")}
					sessions={sessions}
					startTaskSession={startTaskSession}
					enabled
				/>,
			);
		});
		// Navigate away, then reopen → guard cleared, relaunch retried.
		await act(async () => {
			root.render(<Harness selectedCard={null} sessions={sessions} startTaskSession={startTaskSession} enabled />);
		});
		await act(async () => {
			root.render(
				<Harness
					selectedCard={makeSelection("t1", "in_progress")}
					sessions={sessions}
					startTaskSession={startTaskSession}
					enabled
				/>,
			);
		});
		expect(startTaskSession).toHaveBeenCalledTimes(2);
	});
});
