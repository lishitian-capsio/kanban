import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";

import { getPriorityOption, getStatusOption, type VaultTypeView } from "../data/vault-type-registry";

export function StatusBadge({
	view,
	status,
}: {
	view: VaultTypeView;
	status: string | null | undefined;
}): React.ReactElement {
	const option = getStatusOption(view, status);
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
				option?.badgeClass ?? "border-border text-text-tertiary",
			)}
		>
			{option?.label ?? status ?? "—"}
		</span>
	);
}

export function PriorityDot({
	view,
	priority,
}: {
	view: VaultTypeView;
	priority: string | null | undefined;
}): React.ReactElement {
	const option = getPriorityOption(view, priority);
	return <span className={cn("text-[10px] leading-none", option?.dotClass ?? "text-text-tertiary")}>●</span>;
}

export interface VaultSelectOption {
	value: string;
	label: string;
}

interface VaultSelectProps {
	value: string;
	options: VaultSelectOption[];
	onValueChange: (value: string) => void;
	ariaLabel: string;
	className?: string;
}

/** Generic single-select styled like `RequirementSelect`, driven by option objects. */
export function VaultSelect({
	value,
	options,
	onValueChange,
	ariaLabel,
	className,
}: VaultSelectProps): React.ReactElement {
	return (
		<RadixSelect.Root value={value} onValueChange={onValueChange}>
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
								key={option.value}
								value={option.value}
								className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary outline-none data-highlighted:bg-surface-3 data-highlighted:text-text-primary data-[state=checked]:text-text-primary"
							>
								<RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
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
