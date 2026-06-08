import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";

vi.mock("@/hooks/use-is-mobile", () => ({
	useIsMobile: () => false,
}));

const EXPANDED_SENTINEL_HEIGHT = 99999;
const MIN_HEIGHT = 200;
const COLLAPSED_HEIGHT = 400;

// Mirrors the real wiring in useTerminalPanels: "expanded" is represented by
// feeding a huge sentinel initialHeight, and the persist callback's identity is
// tied to isExpanded (it skips persisting while expanded). We intentionally do
// NOT feed reported heights back into initialHeight so a buggy report surfaces
// as a recorded call instead of an infinite render loop that would hang the run.
function TerminalPaneHarness({ onReportHeight }: { onReportHeight: (height: number) => void }) {
	const [isExpanded, setIsExpanded] = useState(false);
	const paneHeight = isExpanded ? EXPANDED_SENTINEL_HEIGHT : COLLAPSED_HEIGHT;

	const handleHeightChange = useCallback(
		(height: number) => {
			if (isExpanded) {
				return;
			}
			onReportHeight(height);
		},
		[isExpanded, onReportHeight],
	);

	return (
		<>
			<button type="button" data-testid="toggle" onClick={() => setIsExpanded((previous) => !previous)}>
				toggle
			</button>
			<ResizableBottomPane
				minHeight={MIN_HEIGHT}
				initialHeight={paneHeight}
				onHeightChange={handleHeightChange}
				isExpanded={isExpanded}
			>
				<div>terminal</div>
			</ResizableBottomPane>
		</>
	);
}

describe("ResizableBottomPane", () => {
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

	it("does not report the stale expanded height when exiting fullscreen", () => {
		const reportedHeights: number[] = [];
		const onReportHeight = (height: number) => {
			reportedHeights.push(height);
		};

		act(() => {
			root.render(<TerminalPaneHarness onReportHeight={onReportHeight} />);
		});

		const toggle = container.querySelector<HTMLButtonElement>('button[data-testid="toggle"]');
		if (!toggle) {
			throw new Error("toggle button not rendered");
		}

		// Enter fullscreen.
		act(() => {
			toggle.click();
		});

		reportedHeights.length = 0;

		// Exit fullscreen. The bug reported the stale expanded height (clamped to
		// roughly the window height) back up here because the onHeightChange
		// identity flips with isExpanded, re-firing the report effect with the
		// not-yet-collapsed internal height. That corrupted the shared pane height
		// and produced the expand/collapse oscillation.
		act(() => {
			toggle.click();
		});

		const reportedExpandedHeight = reportedHeights.find((height) => height > COLLAPSED_HEIGHT);
		expect(reportedExpandedHeight).toBeUndefined();
	});

	it("persists the height the user drags the pane to", () => {
		const reportedHeights: number[] = [];
		const onReportHeight = (height: number) => {
			reportedHeights.push(height);
		};

		act(() => {
			root.render(<TerminalPaneHarness onReportHeight={onReportHeight} />);
		});

		const separator = container.querySelector<HTMLElement>('[role="separator"]');
		if (!separator) {
			throw new Error("resize separator not rendered");
		}

		// Drag the top edge up by 50px, growing the pane from 400 to 450.
		act(() => {
			separator.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 500 }));
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 450 }));
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: 450 }));
		});

		expect(reportedHeights.at(-1)).toBe(450);
	});
});
