import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import type React from "react";
import type { ReactNode } from "react";
import { useCallback } from "react";

import type { VaultDoc } from "../data/vault-doc-model";
import { VaultBoardColumn } from "./vault-board-column";
import type { VaultBoardColumn as VaultBoardColumnModel } from "./vault-status-columns";

/**
 * Generic, presentation-only kanban board. Forked from the task board's
 * `@hello-pangea/dnd` recipe (not its task-coupled components). Columns and cards
 * are supplied by the caller; a cross-column drop calls `onCardMove(docId,
 * toColumnId)`. Within-column reordering is intentionally ignored — cards are
 * ordered by `updatedAt` (see `groupDocsByStatus`); fractional ranking is deferred.
 */
export function VaultBoard({
	columns,
	cardsByColumn,
	onCardMove,
	onCardClick,
	renderCard,
}: {
	columns: VaultBoardColumnModel[];
	cardsByColumn: Record<string, VaultDoc[]>;
	onCardMove: (docId: string, toColumnId: string) => void;
	onCardClick: (id: string) => void;
	renderCard: (doc: VaultDoc) => ReactNode;
}): React.ReactElement {
	const handleDragEnd = useCallback(
		(result: DropResult) => {
			const { draggableId, source, destination } = result;
			if (!destination || destination.droppableId === source.droppableId) {
				return;
			}
			onCardMove(draggableId, destination.droppableId);
		},
		[onCardMove],
	);

	return (
		<DragDropContext onDragEnd={handleDragEnd}>
			<section className="flex flex-1 min-h-0 gap-3 overflow-x-auto p-3">
				{columns.map((column) => (
					<VaultBoardColumn
						key={column.id}
						column={column}
						cards={cardsByColumn[column.id] ?? []}
						onCardClick={onCardClick}
						renderCard={renderCard}
					/>
				))}
			</section>
		</DragDropContext>
	);
}
