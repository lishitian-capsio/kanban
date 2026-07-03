import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitRefsPanel } from "@/components/git-history/git-refs-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeGitRef } from "@/runtime/types";

function makeRef(overrides: Partial<RuntimeGitRef> & Pick<RuntimeGitRef, "name" | "type">): RuntimeGitRef {
	return { hash: "0000000", isHead: false, ...overrides };
}

const REFS: RuntimeGitRef[] = [
	makeRef({ name: "main", type: "branch", isHead: true }),
	makeRef({ name: "feature/login", type: "branch" }),
	makeRef({ name: "kanban/board", type: "branch" }),
	makeRef({ name: "kanban/task/abc123", type: "branch" }),
	makeRef({ name: "kanban/board-archive/1718000000", type: "branch" }),
	makeRef({ name: "origin/kanban/task/abc123", type: "remote" }),
	makeRef({ name: "v1.0.0", type: "tag", hash: "abc1234" }),
	makeRef({ name: "kanban/board-archive/1718000000", type: "tag" }),
];

function findRowButton(container: HTMLElement, label: string): HTMLButtonElement | null {
	const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button.kb-git-ref-row-main"));
	return buttons.find((button) => button.textContent?.includes(label)) ?? null;
}

describe("GitRefsPanel", () => {
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
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function render(
		onCheckoutRef: (branchName: string) => void,
		tagHandlers?: { onCreateTag?: () => void; onDeleteTag?: (name: string) => void },
	): void {
		act(() => {
			root.render(
				<TooltipProvider>
					<GitRefsPanel
						refs={REFS}
						selectedRefName={null}
						isLoading={false}
						panelWidth={240}
						workingCopyChanges={null}
						onSelectRef={() => {}}
						onCheckoutRef={onCheckoutRef}
						onCreateTag={tagHandlers?.onCreateTag}
						onDeleteTag={tagHandlers?.onDeleteTag}
					/>
				</TooltipProvider>,
			);
		});
	}

	function doubleClick(button: HTMLButtonElement): void {
		act(() => {
			button.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
	}

	function clickButton(button: HTMLButtonElement): void {
		act(() => {
			button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	}

	function findByAriaLabel(label: string): HTMLButtonElement | null {
		return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	}

	it("hides task and board-archive branches from the list", () => {
		render(() => {});
		expect(findRowButton(container, "kanban/task/abc123")).toBeNull();
		expect(findRowButton(container, "kanban/board-archive/1718000000")).toBeNull();
		expect(container.textContent).not.toContain("origin/kanban/task/abc123");
	});

	it("switches to an ordinary code branch on double-click", () => {
		const onCheckoutRef = vi.fn();
		render(onCheckoutRef);
		const button = findRowButton(container, "feature/login");
		expect(button).not.toBeNull();
		doubleClick(button as HTMLButtonElement);
		expect(onCheckoutRef).toHaveBeenCalledWith("feature/login");
	});

	it("keeps the board branch visible but does not switch to it on double-click", () => {
		const onCheckoutRef = vi.fn();
		render(onCheckoutRef);
		const button = findRowButton(container, "kanban/board");
		expect(button).not.toBeNull();
		doubleClick(button as HTMLButtonElement);
		expect(onCheckoutRef).not.toHaveBeenCalled();
	});

	it("renders tags in a Tags group and hides internal board-archive tags", () => {
		render(() => {});
		expect(container.textContent).toContain("Tags");
		expect(findRowButton(container, "v1.0.0")).not.toBeNull();
		// The board-archive tag is internal noise and must not appear.
		const archiveButtons = Array.from(
			container.querySelectorAll<HTMLButtonElement>("button.kb-git-ref-row-main"),
		).filter((button) => button.textContent === "kanban/board-archive/1718000000");
		expect(archiveButtons).toHaveLength(0);
	});

	it("does not switch to a tag on double-click", () => {
		const onCheckoutRef = vi.fn();
		render(onCheckoutRef);
		const button = findRowButton(container, "v1.0.0");
		expect(button).not.toBeNull();
		doubleClick(button as HTMLButtonElement);
		expect(onCheckoutRef).not.toHaveBeenCalled();
	});

	it("invokes onCreateTag when the create-tag button is clicked", () => {
		const onCreateTag = vi.fn();
		render(() => {}, { onCreateTag });
		const button = findByAriaLabel("Create tag");
		expect(button).not.toBeNull();
		clickButton(button as HTMLButtonElement);
		expect(onCreateTag).toHaveBeenCalledTimes(1);
	});

	it("invokes onDeleteTag with the tag name when the tag delete button is clicked", () => {
		const onDeleteTag = vi.fn();
		render(() => {}, { onDeleteTag });
		const button = findByAriaLabel("Delete tag v1.0.0");
		expect(button).not.toBeNull();
		clickButton(button as HTMLButtonElement);
		expect(onDeleteTag).toHaveBeenCalledWith("v1.0.0");
	});
});
