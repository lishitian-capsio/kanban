import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileDockPanel } from "@/components/file-surface/file-dock-panel";
import type { UseFileDockResult } from "@/components/file-surface/use-file-dock";
import { TooltipProvider } from "@/components/ui/tooltip";

// The filesystem explorer is tRPC-backed and irrelevant to the dock's placement
// contract, so stub it out — this test only asserts which edge the panel docks to.
vi.mock("@/components/file-surface/filesystem/file-system-explorer", () => ({
	FileSystemExplorer: () => <div data-testid="fs-explorer" />,
}));

function makeDock(position: "left" | "right"): UseFileDockResult {
	return {
		position,
		width: 560,
		collapsed: false,
		dockLeft: vi.fn(),
		dockRight: vi.fn(),
		collapse: vi.fn(),
		expand: vi.fn(),
		setWidth: vi.fn(),
	};
}

describe("FileDockPanel placement", () => {
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderWith(position: "left" | "right"): void {
		act(() => {
			root.render(
				<TooltipProvider>
					<FileDockPanel
						dock={makeDock(position)}
						workspaceId="ws-1"
						fsPath={null}
						onClose={() => {}}
						onOpenPalette={() => {}}
						onOpenFsPath={() => {}}
					/>
				</TooltipProvider>,
			);
		});
	}

	// The docked panel is a sibling of the main column in the outer flex; `order-last`
	// pins it to the right edge. This is the placement session mode reuses (the panel
	// docks alongside CardDetailView exactly as it does the board).
	it("docks to the right by default (order-last)", () => {
		renderWith("right");
		const aside = container.querySelector("aside");
		expect(aside).toBeInstanceOf(HTMLElement);
		expect(aside?.className).toContain("order-last");
		expect(aside?.className).not.toContain("order-first");
	});

	it("docks to the left (order-first) when toggled", () => {
		renderWith("left");
		const aside = container.querySelector("aside");
		expect(aside?.className).toContain("order-first");
		expect(aside?.className).not.toContain("order-last");
	});
});
