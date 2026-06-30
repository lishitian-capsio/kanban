import * as RadixSwitch from "@radix-ui/react-switch";
import { Database } from "lucide-react";
import type React from "react";
import { useId } from "react";

import { cn } from "@/components/ui/cn";
import { useVaultSettings } from "@/components/vault/data/use-vault-settings";

/**
 * Workspace-level gate for the agent-facing `kanban db` CLI, surfaced inside the human
 * Database view — its natural home, since this is the only place the surface lives.
 *
 * Reads and writes the SAME `agentDatabaseAccessEnabled` vault setting (via
 * {@link useVaultSettings}) that everything else does, so there is no second source of
 * truth. The toggle ONLY governs whether agents may run `kanban db` (read-only); the
 * human Database view above is never affected by it.
 */
export function DatabaseAgentAccessControl({ workspaceId }: { workspaceId: string }): React.ReactElement {
	const { agentDatabaseAccessEnabled, isLoading, isMutating, setAgentDatabaseAccessEnabled } =
		useVaultSettings(workspaceId);
	const labelId = useId();
	const descriptionId = `${labelId}-description`;
	const disabled = isLoading || isMutating;
	return (
		<div className="flex shrink-0 flex-col gap-1.5 border-t border-border px-3 py-2.5">
			<div className="flex items-center gap-2">
				<Database
					size={14}
					className={cn("shrink-0", agentDatabaseAccessEnabled ? "text-accent" : "text-text-tertiary")}
				/>
				<span id={labelId} className="flex-1 text-[12px] leading-snug text-text-primary">
					Allow agents to query via the <span className="font-mono">kanban db</span> CLI
				</span>
				<RadixSwitch.Root
					checked={agentDatabaseAccessEnabled}
					disabled={disabled}
					onCheckedChange={(next) => void setAgentDatabaseAccessEnabled(next)}
					aria-labelledby={labelId}
					aria-describedby={descriptionId}
					className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full bg-surface-4 transition-colors data-[state=checked]:bg-accent disabled:cursor-default disabled:opacity-40"
				>
					<RadixSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
				</RadixSwitch.Root>
			</div>
			<p id={descriptionId} className="text-[11px] leading-snug text-text-tertiary">
				{agentDatabaseAccessEnabled
					? "Agents may connect and run read-only queries. Row edits stay in this Database view."
					: "Agents can't use the database CLI — every `kanban db` command is refused."}
			</p>
		</div>
	);
}
