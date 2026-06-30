import { Database } from "lucide-react";
import type React from "react";

import { AgentAccessSwitch } from "@/components/ui/agent-access-switch";
import { cn } from "@/components/ui/cn";
import { useVaultSettings } from "@/components/vault/data/use-vault-settings";

/**
 * Workspace-level gate for the agent-facing `kanban db` CLI, surfaced inside the human
 * Database view — its natural home, since this is the only place the surface lives.
 *
 * Reads and writes the SAME `agentDatabaseAccessEnabled` vault setting (via
 * {@link useVaultSettings}) that everything else does, so there is no second source of
 * truth. The toggle ONLY governs whether agents may run `kanban db` (read-only); the
 * human Database view above is never affected by it. Renders the shared
 * {@link AgentAccessSwitch} so it matches the vault-management toggle exactly.
 */
export function DatabaseAgentAccessControl({ workspaceId }: { workspaceId: string }): React.ReactElement {
	const { agentDatabaseAccessEnabled, isLoading, isMutating, setAgentDatabaseAccessEnabled } =
		useVaultSettings(workspaceId);
	const disabled = isLoading || isMutating;
	return (
		<div className="flex shrink-0 flex-col border-t border-border px-3 py-2.5">
			<AgentAccessSwitch
				icon={
					<Database
						size={14}
						className={cn("shrink-0", agentDatabaseAccessEnabled ? "text-accent" : "text-text-tertiary")}
					/>
				}
				label={
					<>
						Allow agents to query via the <span className="font-mono">kanban db</span> CLI
					</>
				}
				description={
					agentDatabaseAccessEnabled
						? "Agents may connect and run read-only queries. Row edits stay in this Database view."
						: "Agents can't use the database CLI — every `kanban db` command is refused."
				}
				checked={agentDatabaseAccessEnabled}
				disabled={disabled}
				onCheckedChange={(next) => void setAgentDatabaseAccessEnabled(next)}
			/>
		</div>
	);
}
