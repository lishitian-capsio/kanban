import * as Popover from "@radix-ui/react-popover";
import { Filter } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeDbFilter, RuntimeDbFilterOp } from "@/runtime/types";

const OP_LABELS: Record<RuntimeDbFilterOp, string> = {
	eq: "=",
	ne: "≠",
	lt: "<",
	lte: "≤",
	gt: ">",
	gte: "≥",
	contains: "contains",
	starts_with: "starts with",
	ends_with: "ends with",
	is_null: "is null",
	is_not_null: "is not null",
};

const OP_ORDER: RuntimeDbFilterOp[] = [
	"eq",
	"ne",
	"lt",
	"lte",
	"gt",
	"gte",
	"contains",
	"starts_with",
	"ends_with",
	"is_null",
	"is_not_null",
];

function opTakesValue(op: RuntimeDbFilterOp): boolean {
	return op !== "is_null" && op !== "is_not_null";
}

export interface ColumnFilterPopoverProps {
	column: string;
	filter: RuntimeDbFilter | null;
	onApply: (filter: RuntimeDbFilter) => void;
	onClear: () => void;
}

/** Per-column filter editor opened from the grid header funnel. */
export function ColumnFilterPopover({ column, filter, onApply, onClear }: ColumnFilterPopoverProps): React.ReactElement {
	const [open, setOpen] = useState(false);
	const [op, setOp] = useState<RuntimeDbFilterOp>(filter?.op ?? "eq");
	const [value, setValue] = useState(filter?.value ?? "");

	useEffect(() => {
		if (open) {
			setOp(filter?.op ?? "eq");
			setValue(filter?.value ?? "");
		}
	}, [open, filter]);

	const active = filter !== null;

	const apply = () => {
		onApply({ column, op, value: opTakesValue(op) ? value : null });
		setOpen(false);
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label={`Filter ${column}`}
					className={cn(
						"flex h-5 w-5 items-center justify-center rounded hover:bg-surface-3 shrink-0",
						active ? "text-accent" : "text-text-tertiary",
					)}
				>
					<Filter size={12} fill={active ? "currentColor" : "none"} />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={6}
					className="z-50 w-60 rounded-lg border border-border-bright bg-surface-1 p-3 shadow-2xl"
				>
					<div className="mb-2 text-[12px] font-medium text-text-secondary truncate">{column}</div>
					<NativeSelect
						fill
						size="sm"
						value={op}
						onChange={(event) => setOp(event.target.value as RuntimeDbFilterOp)}
						className="mb-2"
					>
						{OP_ORDER.map((option) => (
							<option key={option} value={option}>
								{OP_LABELS[option]}
							</option>
						))}
					</NativeSelect>
					{opTakesValue(op) ? (
						<input
							className="mb-2 h-7 w-full rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary focus:border-border-focus focus:outline-none"
							value={value}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									apply();
								}
							}}
							placeholder="Value"
						/>
					) : null}
					<div className="flex justify-end gap-2">
						{active ? (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									onClear();
									setOpen(false);
								}}
							>
								Clear
							</Button>
						) : null}
						<Button variant="primary" size="sm" onClick={apply}>
							Apply
						</Button>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
