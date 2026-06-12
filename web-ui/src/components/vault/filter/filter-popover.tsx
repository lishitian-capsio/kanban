import * as Popover from "@radix-ui/react-popover";
import { Filter } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeVaultFilterGroup } from "@/runtime/types";

import type { VaultTypeView } from "../data/vault-type-registry";
import { FilterBuilder } from "./filter-builder";
import { countConditions, EMPTY_GROUP } from "./filter-tree";

/** A toolbar button that opens the filter builder in a popover. */
export function FilterPopover({
	view,
	filters,
	onChange,
}: {
	view: VaultTypeView;
	filters: RuntimeVaultFilterGroup;
	onChange: (next: RuntimeVaultFilterGroup) => void;
}): React.ReactElement {
	const count = countConditions(filters);
	const active = count > 0;

	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					className={cn(
						"inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px]",
						active
							? "border-accent/40 bg-accent/10 text-accent"
							: "border-border bg-surface-2 text-text-secondary hover:text-text-primary",
					)}
				>
					<Filter size={13} />
					Filter
					{active ? <span className="rounded-full bg-accent px-1.5 text-[10px] text-white">{count}</span> : null}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					className="z-50 w-[26rem] max-w-[90vw] rounded-lg border border-border bg-surface-1 p-3 shadow-xl"
				>
					<div className="mb-2 flex items-center justify-between">
						<span className="text-[12px] font-semibold text-text-primary">Filters</span>
						{active ? (
							<button
								type="button"
								onClick={() => onChange(EMPTY_GROUP)}
								className="text-[11px] text-text-tertiary hover:text-status-red"
							>
								Clear all
							</button>
						) : null}
					</div>
					<FilterBuilder view={view} group={filters} onChange={onChange} />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
