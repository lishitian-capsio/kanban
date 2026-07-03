import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { FilePopover } from "@/components/file-surface/file-popover";
import { fileSurfaceStore } from "@/components/file-surface";
import { TooltipProvider } from "@/components/ui/tooltip";

// The filesystem explorer is tRPC-backed and heavy (CodeMirror); the popover
// contract we test here is the trigger + shell, not the tree. Stub it out.
vi.mock("@/components/file-surface/filesystem/file-system-explorer", () => ({
	FileSystemExplorer: () => <div data-testid="fs-explorer" />,
}));

function findTrigger(container: HTMLElement): HTMLButtonElement | null {
	return container.querySelector<HTMLButtonElement>('[data-testid="toggle-file-surface-button"]');
}

// The active highlight adds the literal `bg-surface-3` token; the ghost base
// class only carries `hover:bg-surface-3`, so a token-exact check distinguishes them.
function hasClass(element: Element | null | undefined, token: string): boolean {
	return element ? element.className.split(/\s+/).includes(token) : false;
}

describe("FilePopover", () => {
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
			// Reset the shared store so the URL-routed open state doesn't leak.
			fileSurfaceStore.closeLibrary();
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

	function render(): void {
		act(() => {
			root.render(
				<TooltipProvider>
					<FilePopover workspaceId="ws-1" />
				</TooltipProvider>,
			);
		});
	}

	it("renders an icon-only trigger (no visible 'File' text) with a tooltip label", () => {
		render();
		const trigger = findTrigger(container);
		expect(trigger).toBeInstanceOf(HTMLButtonElement);
		// Icon-only: the button has no textual label, only the FileText icon.
		expect(trigger?.textContent?.trim()).toBe("");
		expect(trigger?.getAttribute("aria-label")).toBe("Show Files");
	});

	it("opens the popover on trigger click (URL-routed store), showing the Files panel", () => {
		render();
		const trigger = findTrigger(container);
		expect(fileSurfaceStore.getSnapshot().libraryOpen).toBe(false);

		act(() => {
			trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			trigger?.click();
		});

		expect(fileSurfaceStore.getSnapshot().libraryOpen).toBe(true);
		// The eager popover shell renders the "Files" header + Close button
		// (portaled to <body>) — proof the popover content mounted, not a dock.
		expect(document.body.textContent).toContain("Files");
		expect(document.body.querySelector('[aria-label="Close Files"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("reflects the File surface active state on the trigger", () => {
		render();
		const trigger = findTrigger(container);
		expect(hasClass(trigger, "bg-surface-3")).toBe(false);

		act(() => {
			fileSurfaceStore.openLibrary();
		});

		const activeTrigger = findTrigger(container);
		expect(hasClass(activeTrigger, "bg-surface-3")).toBe(true);
		expect(activeTrigger?.getAttribute("aria-label")).toBe("Hide Files");
		expect(activeTrigger?.getAttribute("aria-pressed")).toBe("true");
	});

	it("closes the popover from the in-panel Close button", () => {
		render();
		act(() => {
			fileSurfaceStore.openLibrary();
		});
		expect(fileSurfaceStore.getSnapshot().libraryOpen).toBe(true);

		const closeButton = document.body.querySelector<HTMLButtonElement>('[aria-label="Close Files"]');
		expect(closeButton).toBeInstanceOf(HTMLButtonElement);

		act(() => {
			closeButton?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			closeButton?.click();
		});

		expect(fileSurfaceStore.getSnapshot().libraryOpen).toBe(false);
	});
});
