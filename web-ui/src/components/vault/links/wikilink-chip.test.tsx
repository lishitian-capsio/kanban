import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WikilinkChip } from "./wikilink-chip";

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

describe("WikilinkChip", () => {
	it("renders a resolved link and opens the target on click", () => {
		const onOpen = vi.fn();
		const onCreate = vi.fn();
		act(() => {
			root.render(
				<WikilinkChip
					target="Acme Corp"
					resolution={{ id: "a", type: "customer", title: "Acme Corp" }}
					onOpen={onOpen}
					onCreate={onCreate}
				>
					Acme Corp
				</WikilinkChip>,
			);
		});

		const chip = container.querySelector("button");
		expect(chip).not.toBeNull();
		expect(chip?.dataset.resolved).toBe("true");
		expect(chip?.textContent).toContain("Acme Corp");

		act(() => chip?.click());
		expect(onOpen).toHaveBeenCalledWith({ id: "a", type: "customer", title: "Acme Corp" });
		expect(onCreate).not.toHaveBeenCalled();
	});

	it("renders an unresolved link in a create state and creates on click", () => {
		const onOpen = vi.fn();
		const onCreate = vi.fn();
		act(() => {
			root.render(
				<WikilinkChip target="Ghost Doc" resolution={null} onOpen={onOpen} onCreate={onCreate}>
					Ghost Doc
				</WikilinkChip>,
			);
		});

		const chip = container.querySelector("button");
		expect(chip?.dataset.resolved).toBe("false");
		expect(chip?.textContent).toContain("Ghost Doc");

		act(() => chip?.click());
		expect(onCreate).toHaveBeenCalledWith("Ghost Doc");
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("does not offer creation when no onCreate handler is supplied", () => {
		act(() => {
			root.render(
				<WikilinkChip target="Ghost Doc" resolution={null}>
					Ghost Doc
				</WikilinkChip>,
			);
		});
		const chip = container.querySelector("button");
		// An unresolved chip with no create handler is inert (not a button).
		expect(chip).toBeNull();
		expect(container.textContent).toContain("Ghost Doc");
	});
});
