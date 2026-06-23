import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCardAskControl } from "@/components/board-card-ask-control";
import { TooltipProvider } from "@/components/ui/tooltip";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function render(props: Partial<Parameters<typeof BoardCardAskControl>[0]> = {}): {
	onAskSelf: ReturnType<typeof vi.fn>;
	onAskKanbanAgent: ReturnType<typeof vi.fn>;
} {
	const onAskSelf = vi.fn();
	const onAskKanbanAgent = vi.fn();
	act(() => {
		root = createRoot(container);
		root.render(
			<TooltipProvider>
				<BoardCardAskControl
					question="Approach A or B?"
					onAskSelf={onAskSelf}
					onAskKanbanAgent={onAskKanbanAgent}
					{...props}
				/>
			</TooltipProvider>,
		);
	});
	return { onAskSelf, onAskKanbanAgent };
}

function mainButton(): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.includes("Ask agent"));
	if (!button) {
		throw new Error("main Ask button not found");
	}
	return button as HTMLButtonElement;
}

describe("BoardCardAskControl", () => {
	it("defaults to the task agent and sends there when clicked", () => {
		const { onAskSelf, onAskKanbanAgent } = render();
		act(() => {
			mainButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onAskSelf).toHaveBeenCalledTimes(1);
		expect(onAskKanbanAgent).not.toHaveBeenCalled();
	});

	it("does not send while loading", () => {
		const { onAskSelf } = render({ isLoading: true });
		expect(mainButton().disabled).toBe(true);
		act(() => {
			mainButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onAskSelf).not.toHaveBeenCalled();
	});

	it("disables the control when disabled", () => {
		render({ disabled: true });
		expect(mainButton().disabled).toBe(true);
	});
});
