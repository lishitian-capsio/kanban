import { Draggable } from "@hello-pangea/dnd";
import type React from "react";
import type { ReactNode } from "react";

import { cn } from "@/components/ui/cn";

import type { VaultDoc } from "../data/vault-doc-model";

/**
 * A draggable board card. Presentation is delegated to `renderCard` so the board
 * stays type-generic; this component only wires the `@hello-pangea/dnd` draggable
 * recipe (forked minimally from the task board's `BoardCard`).
 */
export function VaultBoardCard({
	doc,
	index,
	onClick,
	renderCard,
}: {
	doc: VaultDoc;
	index: number;
	onClick: (id: string) => void;
	renderCard: (doc: VaultDoc) => ReactNode;
}): React.ReactElement {
	return (
		<Draggable draggableId={doc.id} index={index}>
			{(provided, snapshot) => (
				<div
					ref={provided.innerRef}
					{...provided.draggableProps}
					{...provided.dragHandleProps}
					data-doc-id={doc.id}
					onClick={() => onClick(doc.id)}
					className={cn(
						"mb-1.5 cursor-pointer rounded-md border border-border bg-surface-2 p-2.5 text-left outline-none transition-colors hover:border-border-bright",
						snapshot.isDragging && "border-accent shadow-lg",
					)}
					style={provided.draggableProps.style}
				>
					{renderCard(doc)}
				</div>
			)}
		</Draggable>
	);
}
