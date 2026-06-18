import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeBoardSyncStatus } from "@/runtime/types";
import { BoardSyncStatusControl } from "./board-sync-status-control";

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
	previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function makeStatus(overrides: Partial<RuntimeBoardSyncStatus> = {}): RuntimeBoardSyncStatus {
	return {
		state: "synced",
		decoupled: true,
		branch: "kanban/board",
		hasRemote: true,
		aheadCount: 0,
		behindCount: 0,
		autoSyncPaused: false,
		lastError: null,
		...overrides,
	};
}

function render(props: Parameters<typeof BoardSyncStatusControl>[0]): void {
	act(() => {
		root.render(
			<TooltipProvider>
				<BoardSyncStatusControl {...props} />
			</TooltipProvider>,
		);
	});
}

describe("BoardSyncStatusControl", () => {
	it("shows the synced state and exposes push/pull/pause when a remote exists", () => {
		render({
			status: makeStatus({ state: "synced" }),
			runningAction: null,
			isTogglingPause: false,
			onPush: vi.fn(),
			onPull: vi.fn(),
			onTogglePause: vi.fn(),
		});

		const badge = container.querySelector("[data-testid='board-sync-badge']");
		expect(badge?.getAttribute("data-board-sync-state")).toBe("synced");
		expect(badge?.textContent).toContain("Synced");
		expect(container.querySelector("button[aria-label='Push board branch']")).not.toBeNull();
		expect(container.querySelector("button[aria-label='Pull board branch']")).not.toBeNull();
		expect(container.querySelector("button[aria-label='Pause automatic board sync']")).not.toBeNull();
	});

	it("surfaces ahead/behind counts on the action buttons", () => {
		render({
			status: makeStatus({ state: "diverged", aheadCount: 2, behindCount: 3 }),
			runningAction: null,
			isTogglingPause: false,
			onPush: vi.fn(),
			onPull: vi.fn(),
			onTogglePause: vi.fn(),
		});

		expect(container.querySelector("[data-testid='board-sync-badge']")?.getAttribute("data-board-sync-state")).toBe(
			"diverged",
		);
		expect(container.querySelector("button[aria-label='Push board branch']")?.textContent).toContain("2");
		expect(container.querySelector("button[aria-label='Pull board branch']")?.textContent).toContain("3");
	});

	it("invokes the pause handler and shows a resume affordance when paused", () => {
		const onTogglePause = vi.fn();
		render({
			status: makeStatus({ state: "ahead", aheadCount: 1, autoSyncPaused: true }),
			runningAction: null,
			isTogglingPause: false,
			onPush: vi.fn(),
			onPull: vi.fn(),
			onTogglePause,
		});

		const resume = container.querySelector("button[aria-label='Resume automatic board sync']");
		expect(resume).not.toBeNull();
		act(() => (resume as HTMLButtonElement).click());
		expect(onTogglePause).toHaveBeenCalledTimes(1);
	});

	it("hides push/pull for a local-only (no remote) board", () => {
		render({
			status: makeStatus({ state: "local-only", hasRemote: false }),
			runningAction: null,
			isTogglingPause: false,
			onPush: vi.fn(),
			onPull: vi.fn(),
			onTogglePause: vi.fn(),
		});

		expect(container.querySelector("[data-testid='board-sync-badge']")?.textContent).toContain("Local only");
		expect(container.querySelector("button[aria-label='Push board branch']")).toBeNull();
		expect(container.querySelector("button[aria-label='Pull board branch']")).toBeNull();
	});
});
