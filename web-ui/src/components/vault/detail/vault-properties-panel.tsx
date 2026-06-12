import type React from "react";
import { useEffect, useState } from "react";

import type { RuntimeVaultFrontmatterValue } from "@/runtime/types";

import { frontmatterString, type VaultDoc } from "../data/vault-doc-model";
import type { VaultTypeView } from "../data/vault-type-registry";
import { VaultSelect } from "../views/vault-property-controls";

interface VaultPropertiesPanelProps {
	view: VaultTypeView;
	doc: VaultDoc;
	onPatchFrontmatter: (patch: Record<string, RuntimeVaultFrontmatterValue>) => void;
}

function TextProperty({
	label,
	value,
	placeholder,
	onCommit,
}: {
	label: string;
	value: string;
	placeholder: string;
	onCommit: (next: string) => void;
}): React.ReactElement {
	const [draft, setDraft] = useState(value);
	useEffect(() => {
		setDraft(value);
	}, [value]);
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[12px] font-medium text-text-secondary">{label}</span>
			<input
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					if (draft !== value) {
						onCommit(draft);
					}
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.currentTarget.blur();
					}
				}}
				placeholder={placeholder}
				className="h-8 w-36 rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary hover:bg-surface-3 focus:border-border-focus"
			/>
		</div>
	);
}

/** Edits a document's structured frontmatter (status / priority / text refs). */
export function VaultPropertiesPanel({ view, doc, onPatchFrontmatter }: VaultPropertiesPanelProps): React.ReactElement {
	const status = frontmatterString(doc, view.statusKey);
	const textColumns = view.columns.filter((column) => column.kind === "text");

	return (
		<div className="flex flex-wrap gap-6 border-b border-border px-5 py-4">
			<div className="flex flex-col gap-1.5">
				<span className="text-[12px] font-medium text-text-secondary">Status</span>
				<VaultSelect
					value={status}
					options={view.statuses}
					onValueChange={(next) => onPatchFrontmatter({ [view.statusKey]: next })}
					ariaLabel="Status"
					className="w-36"
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<span className="text-[12px] font-medium text-text-secondary">Priority</span>
				<VaultSelect
					value={frontmatterString(doc, "priority")}
					options={view.priorities}
					onValueChange={(next) => onPatchFrontmatter({ priority: next })}
					ariaLabel="Priority"
					className="w-36"
				/>
			</div>
			{textColumns.map((column) => (
				<TextProperty
					key={column.key}
					label={column.label}
					value={frontmatterString(doc, column.key)}
					placeholder={`Add ${column.label.toLowerCase()}…`}
					onCommit={(next) => onPatchFrontmatter({ [column.key]: next })}
				/>
			))}
		</div>
	);
}
