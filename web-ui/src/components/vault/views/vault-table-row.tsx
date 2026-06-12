import type React from "react";

import { cn } from "@/components/ui/cn";

import { frontmatterString, type VaultDoc } from "../data/vault-doc-model";
import type { VaultColumnSpec, VaultTypeView } from "../data/vault-type-registry";
import { PriorityDot, StatusBadge } from "./vault-property-controls";

function formatUpdated(timestamp: number): string {
	if (!timestamp) {
		return "—";
	}
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return "—";
	}
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function ColumnCell({
	view,
	doc,
	column,
}: {
	view: VaultTypeView;
	doc: VaultDoc;
	column: VaultColumnSpec;
}): React.ReactElement {
	switch (column.kind) {
		case "title":
			return <span className="truncate font-medium text-text-primary">{doc.name || "Untitled"}</span>;
		case "status":
			return <StatusBadge view={view} status={frontmatterString(doc, view.statusKey) || null} />;
		case "priority": {
			const priority = frontmatterString(doc, column.key);
			return (
				<span className="inline-flex items-center gap-1.5 text-[13px] text-text-secondary">
					<PriorityDot view={view} priority={priority || null} />
					<span className="capitalize">{priority || "—"}</span>
				</span>
			);
		}
		case "updated":
			return <span className="text-[12px] text-text-tertiary">{formatUpdated(doc.updatedAt)}</span>;
		default: {
			const value = frontmatterString(doc, column.key);
			return <span className="truncate text-[13px] text-text-secondary">{value || "—"}</span>;
		}
	}
}

export function VaultTableRow({
	view,
	doc,
	gridTemplate,
	selected,
	onSelect,
}: {
	view: VaultTypeView;
	doc: VaultDoc;
	gridTemplate: string;
	selected: boolean;
	onSelect: (id: string) => void;
}): React.ReactElement {
	return (
		<button
			type="button"
			onClick={() => onSelect(doc.id)}
			data-doc-id={doc.id}
			className={cn(
				"grid w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-surface-2",
				selected && "bg-surface-2",
			)}
			style={{ gridTemplateColumns: gridTemplate }}
		>
			{view.columns.map((column) => (
				<div key={column.key} className="flex min-w-0 items-center">
					<ColumnCell view={view} doc={doc} column={column} />
				</div>
			))}
		</button>
	);
}
