import type React from "react";
import { useMemo } from "react";
import { Virtuoso } from "react-virtuoso";

import type { VaultDoc } from "../data/vault-doc-model";
import type { VaultColumnSpec, VaultTypeView } from "../data/vault-type-registry";
import { VaultTableRow } from "./vault-table-row";

// Fixed track widths per column kind; the title column flexes to fill the rest.
function columnTrack(column: VaultColumnSpec): string {
	switch (column.kind) {
		case "title":
			return "minmax(0, 1fr)";
		case "status":
			return "120px";
		case "priority":
			return "120px";
		case "updated":
			return "120px";
		default:
			return "minmax(0, 200px)";
	}
}

export function VaultTableView({
	view,
	docs,
	selectedDocId,
	onSelect,
}: {
	view: VaultTypeView;
	docs: VaultDoc[];
	selectedDocId: string | null;
	onSelect: (id: string) => void;
}): React.ReactElement {
	const gridTemplate = useMemo(() => view.columns.map(columnTrack).join(" "), [view.columns]);

	if (docs.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center px-4 py-12 text-center text-[13px] text-text-tertiary">
				No {view.pluralLabel.toLowerCase()} yet. Click “New {view.label}” to create one.
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col min-h-0">
			<div
				className="grid items-center gap-3 border-b border-border bg-surface-1 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary"
				style={{ gridTemplateColumns: gridTemplate }}
			>
				{view.columns.map((column) => (
					<div key={column.key} className="truncate">
						{column.label}
					</div>
				))}
			</div>
			<Virtuoso
				style={{ height: "100%" }}
				className="flex-1"
				data={docs}
				computeItemKey={(_, doc) => doc.id}
				itemContent={(_, doc) => (
					<VaultTableRow
						view={view}
						doc={doc}
						gridTemplate={gridTemplate}
						selected={doc.id === selectedDocId}
						onSelect={onSelect}
					/>
				)}
			/>
		</div>
	);
}
