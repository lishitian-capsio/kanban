import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeRequirementPriority, RuntimeRequirementStatus } from "@/runtime/types";

export const REQUIREMENT_PRIORITIES: RuntimeRequirementPriority[] = ["low", "medium", "high", "urgent"];
export const REQUIREMENT_STATUSES: RuntimeRequirementStatus[] = ["draft", "active", "done", "archived"];

export const PRIORITY_LABELS: Record<RuntimeRequirementPriority, string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
	urgent: "Urgent",
};

export const STATUS_LABELS: Record<RuntimeRequirementStatus, string> = {
	draft: "Draft",
	active: "Active",
	done: "Done",
	archived: "Archived",
};

// Tailwind text-color class for the priority dot, mapped to the design-system status tokens.
export const PRIORITY_DOT_CLASS: Record<RuntimeRequirementPriority, string> = {
	low: "text-text-tertiary",
	medium: "text-status-blue",
	high: "text-status-orange",
	urgent: "text-status-red",
};

export const STATUS_BADGE_CLASS: Record<RuntimeRequirementStatus, string> = {
	draft: "border-border-bright text-text-secondary",
	active: "border-status-blue/40 text-status-blue",
	done: "border-status-green/40 text-status-green",
	archived: "border-border text-text-tertiary",
};

export function PriorityDot({ priority }: { priority: RuntimeRequirementPriority }): React.ReactElement {
	return <span className={cn("text-[10px] leading-none", PRIORITY_DOT_CLASS[priority])}>●</span>;
}

export function StatusBadge({ status }: { status: RuntimeRequirementStatus }): React.ReactElement {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
				STATUS_BADGE_CLASS[status],
			)}
		>
			{STATUS_LABELS[status]}
		</span>
	);
}

interface RequirementSelectProps<T extends string> {
	value: T;
	options: T[];
	labels: Record<T, string>;
	onValueChange: (value: T) => void;
	ariaLabel: string;
	className?: string;
}

export function RequirementSelect<T extends string>({
	value,
	options,
	labels,
	onValueChange,
	ariaLabel,
	className,
}: RequirementSelectProps<T>): React.ReactElement {
	return (
		<RadixSelect.Root value={value} onValueChange={(next) => onValueChange(next as T)}>
			<RadixSelect.Trigger
				aria-label={ariaLabel}
				className={cn(
					"flex h-8 items-center justify-between gap-2 rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none hover:bg-surface-3 focus:border-border-focus",
					className,
				)}
			>
				<RadixSelect.Value />
				<RadixSelect.Icon>
					<ChevronDown size={14} className="text-text-tertiary" />
				</RadixSelect.Icon>
			</RadixSelect.Trigger>
			<RadixSelect.Portal>
				<RadixSelect.Content
					className="z-50 max-h-72 w-(--radix-select-trigger-width) overflow-auto rounded-lg border border-border bg-surface-1 p-1 shadow-xl"
					position="popper"
					sideOffset={4}
					align="start"
				>
					<RadixSelect.Viewport>
						{options.map((option) => (
							<RadixSelect.Item
								key={option}
								value={option}
								className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary outline-none data-highlighted:bg-surface-3 data-highlighted:text-text-primary data-[state=checked]:text-text-primary"
							>
								<RadixSelect.ItemText>{labels[option]}</RadixSelect.ItemText>
								<RadixSelect.ItemIndicator className="ml-auto">
									<Check size={14} className="text-accent" />
								</RadixSelect.ItemIndicator>
							</RadixSelect.Item>
						))}
					</RadixSelect.Viewport>
				</RadixSelect.Content>
			</RadixSelect.Portal>
		</RadixSelect.Root>
	);
}
