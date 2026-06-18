import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TerminalAgentHints } from "@/components/home-agent/terminal-agent-hints";
import { LocalStorageKey } from "@/storage/local-storage-store";

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === text);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Button with text "${text}" was not rendered`);
	}
	return button;
}

describe("TerminalAgentHints", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		localStorage.clear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("persists tips dismissal and restores it", () => {
		act(() => {
			root.render(<TerminalAgentHints />);
		});
		expect(container.textContent).toContain("Tips");
		expect(localStorage.getItem(LocalStorageKey.AgentTipsDismissed)).toBeNull();

		const hideButton = container.querySelector('[aria-label="Dismiss tips"]') as HTMLButtonElement;
		act(() => {
			hideButton.click();
		});

		expect(container.textContent).toContain("Show tips");
		expect(localStorage.getItem(LocalStorageKey.AgentTipsDismissed)).toBe("true");

		const showTipsButton = getButtonByText(container, "Show tips");
		act(() => {
			showTipsButton.click();
		});

		expect(container.textContent).toContain("Tips");
		expect(localStorage.getItem(LocalStorageKey.AgentTipsDismissed)).toBeNull();
	});
});
