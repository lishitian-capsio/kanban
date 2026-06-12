import type React from "react";
import { useEffect, useState } from "react";

import type { RuntimeVaultFrontmatterValue } from "@/runtime/types";

import { CustomerPicker } from "../customer/customer-picker";
import { frontmatterString, type VaultDoc } from "../data/vault-doc-model";
import type { VaultColumnSpec, VaultTypeView } from "../data/vault-type-registry";
import { VaultSelect } from "../views/vault-property-controls";

interface VaultPropertiesPanelProps {
	view: VaultTypeView;
	doc: VaultDoc;
	/** `type:customer` docs, for the customer picker on requirement-like types. */
	customers: VaultDoc[];
	onPatchFrontmatter: (patch: Record<string, RuntimeVaultFrontmatterValue>) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[12px] font-medium text-text-secondary">{label}</span>
			{children}
		</div>
	);
}

function TextProperty({
	value,
	placeholder,
	onCommit,
}: {
	value: string;
	placeholder: string;
	onCommit: (next: string) => void;
}): React.ReactElement {
	const [draft, setDraft] = useState(value);
	useEffect(() => {
		setDraft(value);
	}, [value]);
	return (
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
	);
}

/**
 * Edits a document's structured frontmatter, driven by the type's columns (status /
 * priority / customer picker / free text). Renders nothing for types with no
 * editable properties (e.g. Customer, Note) so their detail surface is just the
 * body + any type-specific extras.
 */
export function VaultPropertiesPanel({
	view,
	doc,
	customers,
	onPatchFrontmatter,
}: VaultPropertiesPanelProps): React.ReactElement | null {
	const editableColumns = view.columns.filter((column) => isEditableKind(column));
	if (editableColumns.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-wrap gap-6 border-b border-border px-5 py-4">
			{editableColumns.map((column) => (
				<Field key={column.key} label={column.label}>
					{renderControl(view, doc, column, customers, onPatchFrontmatter)}
				</Field>
			))}
		</div>
	);
}

function isEditableKind(column: VaultColumnSpec): boolean {
	return (
		column.kind === "status" || column.kind === "priority" || column.kind === "customer" || column.kind === "text"
	);
}

function renderControl(
	view: VaultTypeView,
	doc: VaultDoc,
	column: VaultColumnSpec,
	customers: VaultDoc[],
	onPatchFrontmatter: (patch: Record<string, RuntimeVaultFrontmatterValue>) => void,
): React.ReactElement {
	switch (column.kind) {
		case "status":
			return (
				<VaultSelect
					value={frontmatterString(doc, view.statusKey)}
					options={view.statuses}
					onValueChange={(next) => onPatchFrontmatter({ [view.statusKey]: next })}
					ariaLabel={column.label}
					className="w-36"
				/>
			);
		case "priority":
			return (
				<VaultSelect
					value={frontmatterString(doc, column.key)}
					options={view.priorities}
					onValueChange={(next) => onPatchFrontmatter({ [column.key]: next })}
					ariaLabel={column.label}
					className="w-36"
				/>
			);
		case "customer":
			return (
				<CustomerPicker
					value={frontmatterString(doc, column.key)}
					customers={customers}
					onChange={(next) => onPatchFrontmatter({ [column.key]: next })}
					className="w-48"
				/>
			);
		default:
			return (
				<TextProperty
					value={frontmatterString(doc, column.key)}
					placeholder={`Add ${column.label.toLowerCase()}…`}
					onCommit={(next) => onPatchFrontmatter({ [column.key]: next })}
				/>
			);
	}
}
