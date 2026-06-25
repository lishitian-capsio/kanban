import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COLUMN_VIEW_UNASSIGNED } from "@/state/board-column-view";
import type { BoardCard } from "@/types";
import { type ColumnViewControls, useColumnView } from "./use-column-view";

function createCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: overrides.id ?? "task-1",
		title: overrides.title ?? "Untitled",
		prompt: overrides.prompt ?? "Do the thing",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: overrides.createdAt ?? 1_000,
		updatedAt: overrides.updatedAt ?? 1_000,
		...overrides,
	};
}

const cards = [
	createCard({ id: "a", title: "Banana", createdAt: 30, agentId: "codex" }),
	createCard({ id: "b", title: "apple", createdAt: 10, agentId: "claude" }),
	createCard({ id: "c", title: "Cherry", createdAt: 20 }),
];

let container: HTMLDivElement;
let root: Root;

function renderColumnView(initialCards: BoardCard[]): { getControls: () => ColumnViewControls } {
	let latest: ColumnViewControls | null = null;
	function Harness({ items }: { items: BoardCard[] }): null {
		latest = useColumnView(items, { resolveAgentLabel: (id) => id.toUpperCase() });
		return null;
	}
	act(() => {
		root.render(<Harness items={initialCards} />);
	});
	return {
		getControls: () => {
			if (!latest) {
				throw new Error("hook did not render");
			}
			return latest;
		},
	};
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
});

describe("useColumnView", () => {
	it("starts inactive showing all cards in original order", () => {
		const { getControls } = renderColumnView(cards);
		const controls = getControls();
		expect(controls.isActive).toBe(false);
		expect(controls.displayedCards.map((card) => card.id)).toEqual(["a", "b", "c"]);
	});

	it("filters by search and becomes active", () => {
		const { getControls } = renderColumnView(cards);
		act(() => {
			getControls().setSearch("apple");
		});
		const controls = getControls();
		expect(controls.isActive).toBe(true);
		expect(controls.displayedCards.map((card) => card.id)).toEqual(["b"]);
	});

	it("sorts by title and toggles direction", () => {
		const { getControls } = renderColumnView(cards);
		act(() => {
			getControls().setSort("title", "asc");
		});
		expect(getControls().displayedCards.map((card) => card.id)).toEqual(["b", "a", "c"]);
		act(() => {
			getControls().setSort("title", "desc");
		});
		expect(getControls().displayedCards.map((card) => card.id)).toEqual(["c", "a", "b"]);
	});

	it("derives agent options (with injected label) and an unassigned bucket", () => {
		const { getControls } = renderColumnView(cards);
		expect(getControls().agentOptions).toEqual([
			{ value: "claude", label: "CLAUDE", count: 1 },
			{ value: "codex", label: "CODEX", count: 1 },
			{ value: COLUMN_VIEW_UNASSIGNED, label: "Default agent", count: 1 },
		]);
	});

	it("reset returns to the default view", () => {
		const { getControls } = renderColumnView(cards);
		act(() => {
			getControls().setSearch("apple");
			getControls().setSort("createdAt", "desc");
		});
		expect(getControls().isActive).toBe(true);
		act(() => {
			getControls().reset();
		});
		const controls = getControls();
		expect(controls.isActive).toBe(false);
		expect(controls.displayedCards.map((card) => card.id)).toEqual(["a", "b", "c"]);
	});
});
