import * as RadixSwitch from "@radix-ui/react-switch";
import { Sparkles } from "lucide-react";
import type React from "react";
import { useId } from "react";

import { cn } from "@/components/ui/cn";

/**
 * Presentational toggle for the workspace's vault-takeover switch. When ON, the
 * sidebar agent is authorized to proactively manage vault documents; when OFF
 * (the default), it only touches the vault under an explicit instruction.
 *
 * Pure/controlled — `managed` is the current value, `onChange` reports the next
 * one, and `disabled` blocks interaction (used while a save is in flight). The
 * tRPC wiring lives in the container hook, keeping this unit-testable.
 */
export function VaultManagedToggle({
	managed,
	onChange,
	disabled = false,
}: {
	managed: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
}): React.ReactElement {
	const switchId = useId();
	const descriptionId = `${switchId}-description`;
	return (
		<div className="flex flex-col gap-1.5">
			<label
				htmlFor={switchId}
				className={cn(
					"flex items-center gap-2 text-[13px] text-text-secondary select-none",
					disabled ? "cursor-default opacity-60" : "cursor-pointer",
				)}
			>
				<Sparkles size={14} className={cn("shrink-0", managed ? "text-accent" : "text-text-tertiary")} />
				<span className="flex-1 truncate text-text-primary">Agent vault management</span>
				<RadixSwitch.Root
					id={switchId}
					checked={managed}
					onCheckedChange={onChange}
					disabled={disabled}
					aria-describedby={descriptionId}
					className="relative h-5 w-9 shrink-0 rounded-full bg-surface-4 data-[state=checked]:bg-accent disabled:cursor-default cursor-pointer"
				>
					<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
				</RadixSwitch.Root>
			</label>
			<p id={descriptionId} className="px-0.5 text-[11px] leading-snug text-text-tertiary">
				{managed
					? "The agent may proactively create and maintain vault documents."
					: "The agent only edits the vault when you explicitly ask."}
			</p>
		</div>
	);
}
