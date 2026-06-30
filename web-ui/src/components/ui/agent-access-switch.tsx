import * as RadixSwitch from "@radix-ui/react-switch";
import type React from "react";
import { useId } from "react";

/**
 * A labeled on/off switch row with a one-line description underneath — the shared
 * presentation for the agent-access toggles in Settings (vault management and
 * database access), so the two read as one consistent control. Pure/controlled:
 * `checked` is the current value, `onCheckedChange` reports the next, and `disabled`
 * blocks interaction (used while a save is in flight). The caller supplies the
 * leading `icon` already colored for the current state, and `label`/`description`
 * as nodes so they can carry inline markup (e.g. a `<code>` command name).
 */
export function AgentAccessSwitch({
	icon,
	label,
	description,
	checked,
	disabled = false,
	onCheckedChange,
}: {
	icon: React.ReactNode;
	label: React.ReactNode;
	description: React.ReactNode;
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (next: boolean) => void;
}): React.ReactElement {
	const labelId = useId();
	const descriptionId = `${labelId}-description`;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2">
				{icon}
				<span id={labelId} className="flex-1 text-[12px] leading-snug text-text-primary">
					{label}
				</span>
				<RadixSwitch.Root
					checked={checked}
					disabled={disabled}
					onCheckedChange={onCheckedChange}
					aria-labelledby={labelId}
					aria-describedby={descriptionId}
					className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full bg-surface-4 transition-colors data-[state=checked]:bg-accent disabled:cursor-default disabled:opacity-40"
				>
					<RadixSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
				</RadixSwitch.Root>
			</div>
			<p id={descriptionId} className="text-[11px] leading-snug text-text-tertiary">
				{description}
			</p>
		</div>
	);
}
