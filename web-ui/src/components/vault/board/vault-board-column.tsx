import { Droppable } from "@hello-pangea/dnd";
import type React from "react";
import type { ReactNode } from "react";

import type { VaultDoc } from "../data/vault-doc-model";
import { VaultBoardCard } from "./vault-board-card";
import type { VaultBoardColumn as VaultBoardColumnModel } from "./vault-status-columns";

export function VaultBoardColumn({
	column,
	cards,
	onCardClick,
	renderCard,
}: {
	column: VaultBoardColumnModel;
	cards: VaultDoc[];
	onCardClick: (id: string) => void;
	renderCard: (doc: VaultDoc) => ReactNode;
}): React.ReactElement {
	return (
		<section
			data-column-id={column.id}
			className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-1"
			style={{ flex: "1 1 0" }}
		>
			<div className="flex h-10 items-center gap-2 px-3">
				<span className="text-sm font-semibold text-text-primary">{column.title}</span>
				<span className="text-xs text-text-secondary">{cards.length}</span>
			</div>
			<Droppable droppableId={column.id} type="VAULT_CARD">
				{(provided) => (
					<div
						ref={provided.innerRef}
						{...provided.droppableProps}
						className="kb-vault-column-cards flex-1 overflow-y-auto px-2 pb-2"
					>
						{cards.map((doc, index) => (
							<VaultBoardCard
								key={doc.id}
								doc={doc}
								index={index}
								onClick={onCardClick}
								renderCard={renderCard}
							/>
						))}
						{provided.placeholder}
					</div>
				)}
			</Droppable>
		</section>
	);
}
