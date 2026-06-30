import { Database } from "lucide-react";
import type React from "react";
import { useId } from "react";

import { cn } from "@/components/ui/cn";

/**
 * The two agent-database-access states. Unlike the vault mode this is intentionally a flat
 * on/off switch rather than a progressive tier ladder: the `kanban db` CLI is read-only by
 * design, so the only meaningful question is whether the agent may touch the database at all.
 */
const DB_ACCESS_OPTIONS: ReadonlyArray<{ value: boolean; label: string; description: string }> = [
	{
		value: false,
		label: "Off",
		description: "The agent can't use the database CLI — every `kanban db` command is refused.",
	},
	{
		value: true,
		label: "On",
		description: "The agent may connect and run read-only queries. Row edits stay in the human Database view.",
	},
];

/**
 * Presentational segmented control for the workspace's agent-database-access gate. Mirrors
 * {@link VaultModeSelect} so the two agent-capability switches read as siblings in the Vault
 * settings popover. Pure/controlled — `enabled` is the current value, `onChange` reports the
 * next, and `disabled` blocks interaction while a save is in flight.
 */
export function DatabaseAccessSelect({
	enabled,
	onChange,
	disabled = false,
}: {
	enabled: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
}): React.ReactElement {
	const groupId = useId();
	const descriptionId = `${groupId}-description`;
	const activeDescription = DB_ACCESS_OPTIONS.find((option) => option.value === enabled)?.description ?? "";
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2 text-[13px] text-text-secondary">
				<Database size={14} className={cn("shrink-0", enabled ? "text-accent" : "text-text-tertiary")} />
				<span className="flex-1 truncate text-text-primary">Agent database access</span>
			</div>
			<div
				role="radiogroup"
				aria-label="Agent database access"
				aria-describedby={descriptionId}
				className={cn(
					"flex items-stretch gap-0.5 rounded-md border border-border bg-surface-2 p-0.5",
					disabled && "opacity-60",
				)}
			>
				{DB_ACCESS_OPTIONS.map((option) => {
					const selected = option.value === enabled;
					return (
						<button
							key={option.label}
							type="button"
							role="radio"
							aria-checked={selected}
							disabled={disabled}
							onClick={() => onChange(option.value)}
							className={cn(
								"flex-1 truncate rounded-sm px-1.5 py-1 text-[11px] font-medium transition-colors",
								disabled ? "cursor-default" : "cursor-pointer",
								selected
									? "bg-accent text-white"
									: "text-text-secondary hover:bg-surface-3 hover:text-text-primary",
							)}
						>
							{option.label}
						</button>
					);
				})}
			</div>
			<p id={descriptionId} className="px-0.5 text-[11px] leading-snug text-text-tertiary">
				{activeDescription}
			</p>
		</div>
	);
}
