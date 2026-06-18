import { Sparkles } from "lucide-react";
import type React from "react";
import { useId } from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeVaultMode } from "@/runtime/types";

/**
 * The four progressive vault-takeover tiers, in order. Each tier is a superset of
 * the previous one — `off` injects nothing into the agent's system prompt, and each
 * step adds another layer of vault guidance (see `RuntimeVaultSettings.vaultMode`).
 */
const VAULT_MODE_OPTIONS: ReadonlyArray<{ value: RuntimeVaultMode; label: string; description: string }> = [
	{
		value: "off",
		label: "Off",
		description: "No vault guidance is given to the agent — it won't touch the vault.",
	},
	{
		value: "cli-only",
		label: "CLI only",
		description: "The agent learns the vault CLI commands, but not your document types.",
	},
	{
		value: "on-demand",
		label: "On demand",
		description: "The agent also sees your document types and loads each type's guidance on demand.",
	},
	{
		value: "managed",
		label: "Managed",
		description: "The agent may proactively create and maintain vault documents on its own initiative.",
	},
];

/**
 * Presentational segmented control for the workspace's vault-takeover mode. The
 * four tiers are strictly progressive: each one injects everything the previous
 * tier does, plus more. Pure/controlled — `mode` is the current value, `onChange`
 * reports the next, and `disabled` blocks interaction (used while a save is in
 * flight). The tRPC wiring lives in the container hook, keeping this unit-testable.
 */
export function VaultModeSelect({
	mode,
	onChange,
	disabled = false,
}: {
	mode: RuntimeVaultMode;
	onChange: (next: RuntimeVaultMode) => void;
	disabled?: boolean;
}): React.ReactElement {
	const groupId = useId();
	const descriptionId = `${groupId}-description`;
	const activeDescription = VAULT_MODE_OPTIONS.find((option) => option.value === mode)?.description ?? "";
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2 text-[13px] text-text-secondary">
				<Sparkles size={14} className={cn("shrink-0", mode === "off" ? "text-text-tertiary" : "text-accent")} />
				<span className="flex-1 truncate text-text-primary">Agent vault management</span>
			</div>
			<div
				role="radiogroup"
				aria-label="Agent vault management mode"
				aria-describedby={descriptionId}
				className={cn(
					"flex items-stretch gap-0.5 rounded-md border border-border bg-surface-2 p-0.5",
					disabled && "opacity-60",
				)}
			>
				{VAULT_MODE_OPTIONS.map((option) => {
					const selected = option.value === mode;
					return (
						<button
							key={option.value}
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
