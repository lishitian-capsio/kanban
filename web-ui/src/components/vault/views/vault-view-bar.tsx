import { LayoutGrid, Table as TableIcon } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeVaultViewLayout } from "@/runtime/types";

import type { VaultTypeView } from "../data/vault-type-registry";
import { FilterPopover } from "../filter/filter-popover";
import { ColumnsControl } from "./columns-control";
import { SaveViewControls } from "./save-view-controls";
import { SortControl } from "./sort-control";
import type { VaultViewStateResult } from "./use-vault-view-state";

function LayoutToggle({
	layout,
	onChange,
}: {
	layout: RuntimeVaultViewLayout;
	onChange: (layout: RuntimeVaultViewLayout) => void;
}): React.ReactElement {
	return (
		<div className="flex items-center rounded-md border border-border bg-surface-2 p-0.5">
			{(["table", "board"] as const).map((option) => (
				<button
					key={option}
					type="button"
					aria-label={`${option} view`}
					onClick={() => onChange(option)}
					className={cn(
						"flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-text-secondary hover:text-text-primary",
						layout === option && "bg-surface-3 text-text-primary",
					)}
				>
					{option === "table" ? <TableIcon size={13} /> : <LayoutGrid size={13} />}
				</button>
			))}
		</div>
	);
}

function ViewTab({
	label,
	active,
	onClick,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
}): React.ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"h-7 rounded-md px-2.5 text-[12px] font-medium",
				active ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:text-text-primary",
			)}
		>
			{label}
		</button>
	);
}

/**
 * The vault toolbar: saved-view tabs on the left; sort / filter / columns / layout
 * controls and save actions on the right. All control state lives in
 * {@link VaultViewStateResult}; this component is presentation + wiring only.
 */
export function VaultViewBar({
	view,
	state,
	supportsBoard,
}: {
	view: VaultTypeView;
	state: VaultViewStateResult;
	supportsBoard: boolean;
}): React.ReactElement {
	const { views, selectedViewId, selectView, draft, setFilters, setSort, setLayout, setListPropertiesDisplay } = state;

	return (
		<div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-1 px-5 py-2">
			<div className="flex items-center gap-0.5">
				<ViewTab
					label={`All ${view.pluralLabel}`}
					active={selectedViewId === null}
					onClick={() => selectView(null)}
				/>
				{views.map((saved) => (
					<ViewTab
						key={saved.id}
						label={saved.name}
						active={selectedViewId === saved.id}
						onClick={() => selectView(saved.id)}
					/>
				))}
			</div>

			<div className="ml-auto flex items-center gap-2">
				<SortControl view={view} sort={draft.sort} onChange={setSort} />
				<FilterPopover view={view} filters={draft.filters} onChange={setFilters} />
				{draft.layout === "table" ? (
					<ColumnsControl
						view={view}
						listPropertiesDisplay={draft.listPropertiesDisplay}
						onChange={setListPropertiesDisplay}
					/>
				) : null}
				{supportsBoard ? <LayoutToggle layout={draft.layout} onChange={setLayout} /> : null}
				<SaveViewControls state={state} />
			</div>
		</div>
	);
}
