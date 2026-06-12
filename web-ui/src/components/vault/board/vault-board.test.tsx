import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultDoc } from "../data/vault-doc-model";
import { getVaultTypeView } from "../data/vault-type-registry";
import { VaultBoard } from "./vault-board";
import { groupDocsByStatus } from "./vault-status-columns";

// Capture the board's onDragEnd so a test can drive a synthetic drop, and render
// Droppable/Draggable as plain wrappers (the dnd behavior itself is not under test).
const dndMock = vi.hoisted(() => ({
	onDragEnd: null as ((result: unknown) => void) | null,
}));

vi.mock("@hello-pangea/dnd", () => ({
	DragDropContext: ({
		children,
		onDragEnd,
	}: {
		children: ReactNode;
		onDragEnd: (result: unknown) => void;
	}): ReactNode => {
		dndMock.onDragEnd = onDragEnd;
		return children;
	},
	Droppable: ({ children }: { children: (provided: unknown) => ReactNode }): ReactNode =>
		children({ innerRef: () => {}, droppableProps: {}, placeholder: null }),
	Draggable: ({ children }: { children: (provided: unknown, snapshot: unknown) => ReactNode }): ReactNode =>
		children({ innerRef: () => {}, draggableProps: { style: {} }, dragHandleProps: {} }, { isDragging: false }),
}));

function makeDoc(id: string, status: string, updatedAt: number): VaultDoc {
	return {
		id,
		type: "requirement",
		name: `Doc ${id}`,
		frontmatter: { status, priority: "medium" },
		body: "",
		relativePath: `docs/requirement/${id}.md`,
		createdAt: 1,
		updatedAt,
	};
}

describe("groupDocsByStatus", () => {
	const view = getVaultTypeView("requirement");
	if (!view) {
		throw new Error("requirement view missing");
	}

	it("builds one column per status in registry order", () => {
		const grouped = groupDocsByStatus(view, []);
		expect(grouped.columns.map((column) => column.id)).toEqual(["proposed", "clarified", "parked", "invalid"]);
	});

	it("places docs into their status column and sorts by updatedAt desc", () => {
		const grouped = groupDocsByStatus(view, [
			makeDoc("a", "clarified", 100),
			makeDoc("b", "clarified", 300),
			makeDoc("c", "parked", 200),
		]);
		expect((grouped.cardsByColumn.clarified ?? []).map((doc) => doc.id)).toEqual(["b", "a"]);
		expect((grouped.cardsByColumn.parked ?? []).map((doc) => doc.id)).toEqual(["c"]);
		expect(grouped.cardsByColumn.proposed ?? []).toEqual([]);
	});

	it("falls back to the first column for missing or unknown status", () => {
		const grouped = groupDocsByStatus(view, [makeDoc("a", "", 1), makeDoc("b", "bogus", 2)]);
		expect((grouped.cardsByColumn.proposed ?? []).map((doc) => doc.id)).toEqual(["b", "a"]);
	});
});

describe("VaultBoard", () => {
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
		dndMock.onDragEnd = null;
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderBoard(onCardMove: (docId: string, toColumnId: string) => void): void {
		const columns = [
			{ id: "proposed", title: "Proposed" },
			{ id: "clarified", title: "Clarified" },
		];
		const cardsByColumn = {
			proposed: [makeDoc("doc-1", "proposed", 1)],
			clarified: [] as VaultDoc[],
		};
		act(() => {
			root.render(
				<VaultBoard
					columns={columns}
					cardsByColumn={cardsByColumn}
					onCardMove={onCardMove}
					onCardClick={() => {}}
					renderCard={(doc) => <span>{doc.name}</span>}
				/>,
			);
		});
	}

	it("calls onCardMove with the doc id and destination column on a cross-column drop", () => {
		const onCardMove = vi.fn();
		renderBoard(onCardMove);
		act(() => {
			dndMock.onDragEnd?.({
				draggableId: "doc-1",
				source: { droppableId: "proposed", index: 0 },
				destination: { droppableId: "clarified", index: 0 },
			});
		});
		expect(onCardMove).toHaveBeenCalledWith("doc-1", "clarified");
	});

	it("ignores a drop within the same column", () => {
		const onCardMove = vi.fn();
		renderBoard(onCardMove);
		act(() => {
			dndMock.onDragEnd?.({
				draggableId: "doc-1",
				source: { droppableId: "proposed", index: 0 },
				destination: { droppableId: "proposed", index: 0 },
			});
		});
		expect(onCardMove).not.toHaveBeenCalled();
	});

	it("ignores a drop with no destination", () => {
		const onCardMove = vi.fn();
		renderBoard(onCardMove);
		act(() => {
			dndMock.onDragEnd?.({
				draggableId: "doc-1",
				source: { droppableId: "proposed", index: 0 },
				destination: null,
			});
		});
		expect(onCardMove).not.toHaveBeenCalled();
	});
});
