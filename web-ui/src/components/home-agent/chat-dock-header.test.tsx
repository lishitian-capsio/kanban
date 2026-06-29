import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatDockControls } from "@/components/home-agent/chat-dock-header";
import { TooltipProvider } from "@/components/ui/tooltip";

const noop = (): void => {};

function renderControls(root: Root, isFullscreen: boolean): void {
	act(() => {
		root.render(
			<TooltipProvider>
				<ChatDockControls
					position="left"
					isFullscreen={isFullscreen}
					onDockLeft={noop}
					onDockRight={noop}
					onFloat={noop}
					onEnterFullscreen={noop}
					onExitFullscreen={noop}
					onClose={noop}
					onCollapse={noop}
					onHide={noop}
				/>
			</TooltipProvider>,
		);
	});
}

const DOCK_LABELS = ["Dock to left", "Dock to right", "Detach as floating window"];

describe("ChatDockControls", () => {
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
		// Radix tooltips schedule timers; keep them deterministic.
		vi.useFakeTimers();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	const labelExists = (label: string): boolean =>
		container.querySelector(`[aria-label="${label}"]`) !== null;

	it("hides the dock-position targets in fullscreen, keeping the exit-fullscreen toggle", () => {
		renderControls(root, true);

		for (const label of DOCK_LABELS) {
			expect(labelExists(label)).toBe(false);
		}
		expect(labelExists("Exit fullscreen")).toBe(true);
	});

	it("shows all dock-position targets when not fullscreen", () => {
		renderControls(root, false);

		for (const label of DOCK_LABELS) {
			expect(labelExists(label)).toBe(true);
		}
		// The fullscreen toggle reads as "expand" while docked, not "exit".
		expect(labelExists("Expand to fullscreen workspace")).toBe(true);
	});
});
