import * as Popover from "@radix-ui/react-popover";
import { ArrowDownNarrowWide, ArrowUpNarrowWide, ListFilter, Search, X } from "lucide-react";
import { useId } from "react";

import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import { Tooltip } from "@/components/ui/tooltip";
import type { ColumnViewControls } from "@/hooks/use-column-view";
import type { ColumnSortKey } from "@/state/board-column-view";

const ALL_VALUE = "__all__";

const SORT_KEY_LABELS: Record<ColumnSortKey, string> = {
	rank: "Manual order",
	createdAt: "Created",
	updatedAt: "Updated",
	title: "Title",
};

/** Count of individually-set filters/sorts, shown as a badge on the trigger. */
function countActiveControls(controls: ColumnViewControls): number {
	let count = 0;
	if (controls.view.search.trim() !== "") {
		count += 1;
	}
	if (controls.view.agentId !== null) {
		count += 1;
	}
	if (controls.view.ownerKey !== null) {
		count += 1;
	}
	if (controls.view.sortKey !== "rank") {
		count += 1;
	}
	return count;
}

/**
 * A per-column toolbar control: a popover holding a text search plus agent,
 * owner and sort selectors. Purely presentational — all state lives in the
 * {@link ColumnViewControls} the parent column owns, so each column's controls
 * are independent.
 */
export function BoardColumnFilterControls({
	controls,
	columnTitle,
}: {
	controls: ColumnViewControls;
	columnTitle: string;
}): React.ReactElement {
	const searchId = useId();
	const agentId = useId();
	const ownerId = useId();
	const sortId = useId();
	const activeCount = countActiveControls(controls);
	const { view, isActive, agentOptions, ownerOptions } = controls;
	const sortDirectionDisabled = view.sortKey === "rank";

	return (
		<Popover.Root>
			<Tooltip content={`Filter & sort ${columnTitle}`}>
				<Popover.Trigger asChild>
					<button
						type="button"
						aria-label={`Filter and sort ${columnTitle}`}
						className={cn(
							"inline-flex h-7 items-center gap-1 rounded-md border px-1.5 text-[12px] cursor-pointer transition-colors",
							isActive
								? "border-accent/40 bg-accent/10 text-accent"
								: "border-border bg-surface-2 text-text-secondary hover:text-text-primary hover:border-border-bright",
						)}
					>
						<ListFilter size={14} />
						{activeCount > 0 ? (
							<span className="min-w-[14px] rounded-full bg-accent px-1 text-center text-[10px] leading-[14px] text-white">
								{activeCount}
							</span>
						) : null}
					</button>
				</Popover.Trigger>
			</Tooltip>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					className="z-50 flex w-[18rem] max-w-[90vw] flex-col gap-3 rounded-lg border border-border bg-surface-1 p-3 shadow-xl"
				>
					<div className="flex items-center justify-between">
						<span className="text-[12px] font-semibold text-text-primary">Filter & sort</span>
						{isActive ? (
							<button
								type="button"
								onClick={controls.reset}
								className="inline-flex items-center gap-1 text-[11px] text-text-tertiary hover:text-status-red cursor-pointer"
							>
								<X size={11} />
								Clear
							</button>
						) : null}
					</div>

					<label htmlFor={searchId} className="flex flex-col gap-1">
						<span className="text-[11px] font-medium text-text-secondary">Search</span>
						<div className="relative flex items-center">
							<Search size={13} aria-hidden className="pointer-events-none absolute left-2 text-text-tertiary" />
							<input
								id={searchId}
								type="text"
								value={view.search}
								onChange={(event) => controls.setSearch(event.currentTarget.value)}
								placeholder="Title or description…"
								className="h-8 w-full rounded-md border border-border-bright bg-surface-2 pl-7 pr-7 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
							{view.search ? (
								<button
									type="button"
									aria-label="Clear search"
									onClick={() => controls.setSearch("")}
									className="absolute right-1.5 inline-flex cursor-pointer text-text-tertiary hover:text-text-primary"
								>
									<X size={13} />
								</button>
							) : null}
						</div>
					</label>

					<label htmlFor={agentId} className="flex flex-col gap-1">
						<span className="text-[11px] font-medium text-text-secondary">Agent</span>
						<NativeSelect
							id={agentId}
							size="sm"
							fill
							value={view.agentId ?? ALL_VALUE}
							onChange={(event) => {
								const next = event.currentTarget.value;
								controls.setAgentId(next === ALL_VALUE ? null : next);
							}}
							disabled={agentOptions.length === 0}
						>
							<option value={ALL_VALUE}>All agents</option>
							{agentOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label} ({option.count})
								</option>
							))}
						</NativeSelect>
					</label>

					<label htmlFor={ownerId} className="flex flex-col gap-1">
						<span className="text-[11px] font-medium text-text-secondary">Owner</span>
						<NativeSelect
							id={ownerId}
							size="sm"
							fill
							value={view.ownerKey ?? ALL_VALUE}
							onChange={(event) => {
								const next = event.currentTarget.value;
								controls.setOwnerKey(next === ALL_VALUE ? null : next);
							}}
							disabled={ownerOptions.length === 0}
						>
							<option value={ALL_VALUE}>All owners</option>
							{ownerOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label} ({option.count})
								</option>
							))}
						</NativeSelect>
					</label>

					<div className="flex flex-col gap-1">
						<span className="text-[11px] font-medium text-text-secondary">Sort</span>
						<div className="flex items-center gap-1.5">
							<NativeSelect
								id={sortId}
								size="sm"
								fill
								value={view.sortKey}
								onChange={(event) =>
									controls.setSort(event.currentTarget.value as ColumnSortKey, view.sortDirection)
								}
							>
								{(Object.keys(SORT_KEY_LABELS) as ColumnSortKey[]).map((key) => (
									<option key={key} value={key}>
										{SORT_KEY_LABELS[key]}
									</option>
								))}
							</NativeSelect>
							<Tooltip content={view.sortDirection === "asc" ? "Ascending" : "Descending"}>
								<button
									type="button"
									aria-label={`Sort direction: ${view.sortDirection === "asc" ? "ascending" : "descending"}`}
									disabled={sortDirectionDisabled}
									onClick={() => controls.setSort(view.sortKey, view.sortDirection === "asc" ? "desc" : "asc")}
									className={cn(
										"inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-bright bg-surface-2 text-text-secondary cursor-pointer hover:bg-surface-3 hover:text-text-primary",
										"disabled:cursor-default disabled:opacity-40",
									)}
								>
									{view.sortDirection === "asc" ? (
										<ArrowUpNarrowWide size={14} />
									) : (
										<ArrowDownNarrowWide size={14} />
									)}
								</button>
							</Tooltip>
						</div>
					</div>

					{isActive ? (
						<p className="m-0 text-[11px] leading-snug text-text-tertiary">
							Drag is disabled while a filter or sort is active.
						</p>
					) : null}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
