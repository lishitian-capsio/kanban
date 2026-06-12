import { ArrowDownNarrowWide, ArrowUpNarrowWide } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeVaultSort } from "@/runtime/types";

import type { VaultTypeView } from "../data/vault-type-registry";
import { availableFilterFields } from "../filter/filter-fields";

/** Field + direction picker for the view's sort. An empty field clears sorting. */
export function SortControl({
	view,
	sort,
	onChange,
}: {
	view: VaultTypeView;
	sort: RuntimeVaultSort | null;
	onChange: (next: RuntimeVaultSort | null) => void;
}): React.ReactElement {
	const fields = availableFilterFields(view).filter((field) => field.key !== "type");

	function handleFieldChange(field: string): void {
		onChange(field ? { field, direction: sort?.direction ?? "asc" } : null);
	}

	function toggleDirection(): void {
		if (sort) {
			onChange({ field: sort.field, direction: sort.direction === "asc" ? "desc" : "asc" });
		}
	}

	return (
		<div className="flex items-center gap-1">
			<NativeSelect
				size="sm"
				className="h-7 text-[12px]"
				value={sort?.field ?? ""}
				onChange={(event) => handleFieldChange(event.target.value)}
				aria-label="Sort field"
			>
				<option value="">No sort</option>
				{fields.map((field) => (
					<option key={field.key} value={field.key}>
						{field.label}
					</option>
				))}
			</NativeSelect>
			{sort ? (
				<button
					type="button"
					onClick={toggleDirection}
					aria-label={sort.direction === "asc" ? "Ascending" : "Descending"}
					className={cn(
						"flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-2",
						"text-text-secondary hover:text-text-primary",
					)}
				>
					{sort.direction === "asc" ? <ArrowUpNarrowWide size={14} /> : <ArrowDownNarrowWide size={14} />}
				</button>
			) : null}
		</div>
	);
}
