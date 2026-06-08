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
const NAVBAR_HEIGHT_PX = 40;

// Matches getMaxPaneHeight in the component for the jsdom window height.
function expectedMaxHeight(): number {
	return Math.max(MIN_HEIGHT, Math.floor(window.innerHeight - NAVBAR_HEIGHT_PX));
}

function expectedDefaultHeight(): number {
	return Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.5 - NAVBAR_HEIGHT_PX));
}

function readRenderedHeight(host: HTMLElement): number {
	const pane = host.firstElementChild as HTMLElement | null;
	if (!pane) {
		throw new Error("pane not rendered");
	}
	const match = /(\d+(?:\.\d+)?)px/.exec(pane.style.flex || pane.style.flexBasis);
	if (!match) {
		throw new Error(`could not read pane height from flex: "${pane.style.flex}"`);
	}
	return Number(match[1]);
}

// Mirrors the real wiring in useTerminalPanels: "expanded" is represented by
// feeding a huge sentinel initialHeight, and the persist callback's identity is
// tied to isExpanded (it skips persisting while expanded). The stored height is
// fed straight back into initialHeight, exactly like the shared pane height.
function TerminalPaneHarness({ onReportHeight }: { onReportHeight?: (height: number) => void }) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [storedHeight, setStoredHeight] = useState<number>(COLLAPSED_HEIGHT);
	const paneHeight = isExpanded ? EXPANDED_SENTINEL_HEIGHT : storedHeight;

	const handleHeightChange = useCallback(
		(height: number) => {
			if (isExpanded) {
				return;
			}
			setStoredHeight(height);
			onReportHeight?.(height);
		},
		[isExpanded, onReportHeight],
	);

	return (
		<>
			<button type="button" data-testid="toggle" onClick={() => setIsExpanded((previous) => !previous)}>
				toggle
			</button>
			<span data-testid="stored">{storedHeight}</span>
			<div data-testid="pane-host">
				<ResizableBottomPane
					minHeight={MIN_HEIGHT}
					initialHeight={paneHeight}
					onHeightChange={handleHeightChange}
					isExpanded={isExpanded}
				>
					<div>terminal</div>
				</ResizableBottomPane>
			</div>
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

	function getHost(): HTMLElement {
		const host = container.querySelector<HTMLElement>('[data-testid="pane-host"]');
		if (!host) {
			throw new Error("pane host not rendered");
		}
		return host;
	}

	it("returns to the collapsed height when exiting fullscreen", () => {
		act(() => {
			root.render(<TerminalPaneHarness />);
		});
		expect(readRenderedHeight(getHost())).toBe(COLLAPSED_HEIGHT);

		const toggle = container.querySelector<HTMLButtonElement>('button[data-testid="toggle"]');
		if (!toggle) {
			throw new Error("toggle button not rendered");
		}

		// Enter fullscreen: the pane fills the available height.
		act(() => {
			toggle.click();
		});
		expect(readRenderedHeight(getHost())).toBe(expectedMaxHeight());

		// Exit fullscreen: the pane must shrink back to the collapsed height
		// instead of staying full-size (no oscillation, no stuck fullscreen).
		act(() => {
			toggle.click();
		});
		expect(readRenderedHeight(getHost())).toBe(COLLAPSED_HEIGHT);

		const stored = container.querySelector('[data-testid="stored"]');
		expect(stored?.textContent).toBe(String(COLLAPSED_HEIGHT));
	});

	it("does not report the fullscreen height back up when exiting fullscreen", () => {
		const reportedHeights: number[] = [];
		act(() => {
			root.render(<TerminalPaneHarness onReportHeight={(height) => reportedHeights.push(height)} />);
		});

		const toggle = container.querySelector<HTMLButtonElement>('button[data-testid="toggle"]');
		if (!toggle) {
			throw new Error("toggle button not rendered");
		}

		act(() => {
			toggle.click();
		});
		reportedHeights.length = 0;
		act(() => {
			toggle.click();
		});

		expect(reportedHeights.find((height) => height > COLLAPSED_HEIGHT)).toBeUndefined();
	});

	it("self-heals a stale fullscreen-sized stored height", () => {
		// Older builds could persist a height that fills the screen, which would
		// make a collapsed pane indistinguishable from fullscreen.
		act(() => {
			root.render(
				<div data-testid="pane-host">
					<ResizableBottomPane minHeight={MIN_HEIGHT} initialHeight={expectedMaxHeight()} isExpanded={false}>
						<div>terminal</div>
					</ResizableBottomPane>
				</div>,
			);
		});

		expect(readRenderedHeight(getHost())).toBe(expectedDefaultHeight());
	});

	it("persists the height the user drags the pane to", () => {
		const reportedHeights: number[] = [];
		act(() => {
			root.render(<TerminalPaneHarness onReportHeight={(height) => reportedHeights.push(height)} />);
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
		expect(readRenderedHeight(getHost())).toBe(450);
	});
});
