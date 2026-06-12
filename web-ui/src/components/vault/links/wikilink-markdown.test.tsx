import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanMarkdownContent } from "@/components/detail-panels/kanban-markdown-content";

import { buildWikilinkResolver } from "./wikilink-resolution";

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

describe("KanbanMarkdownContent wikilinks", () => {
	const resolve = buildWikilinkResolver([
		{
			target: "Acme Corp",
			label: undefined,
			source: { kind: "body" },
			resolvedId: "a",
			resolvedType: "customer",
			resolvedTitle: "Acme Corp",
		},
	]);

	it("renders a resolved wikilink as a clickable chip that opens the doc", () => {
		const onOpen = vi.fn();
		act(() => {
			root.render(
				<KanbanMarkdownContent
					content="Anchored to [[Acme Corp]] for delivery."
					wikilinks={{ resolve, onOpen }}
				/>,
			);
		});

		const chip = container.querySelector('button[data-resolved="true"]');
		expect(chip).not.toBeNull();
		expect(chip?.textContent).toContain("Acme Corp");

		act(() => (chip as HTMLButtonElement).click());
		expect(onOpen).toHaveBeenCalledWith({ id: "a", type: "customer", title: "Acme Corp" });
	});

	it("renders an unresolved wikilink in the create state", () => {
		const onCreate = vi.fn();
		act(() => {
			root.render(
				<KanbanMarkdownContent content="See [[Unknown Thing]] later." wikilinks={{ resolve, onCreate }} />,
			);
		});

		const chip = container.querySelector('button[data-resolved="false"]');
		expect(chip).not.toBeNull();
		act(() => (chip as HTMLButtonElement).click());
		expect(onCreate).toHaveBeenCalledWith("Unknown Thing");
	});

	it("honors a custom label while still resolving by target", () => {
		act(() => {
			root.render(<KanbanMarkdownContent content="[[Acme Corp|our client]]" wikilinks={{ resolve }} />);
		});
		const chip = container.querySelector('button[data-resolved="true"]');
		expect(chip?.textContent).toContain("our client");
		expect(chip?.textContent).not.toContain("Acme Corp");
	});

	it("leaves wikilinks as literal text when no binding is provided", () => {
		act(() => {
			root.render(<KanbanMarkdownContent content="Plain [[Acme Corp]] text." />);
		});
		expect(container.querySelector("button")).toBeNull();
		expect(container.textContent).toContain("[[Acme Corp]]");
	});
});
