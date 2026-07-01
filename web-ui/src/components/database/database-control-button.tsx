import * as RadixPopover from "@radix-ui/react-popover";
import { ChevronDown, Database } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { AgentAccessSwitch } from "@/components/ui/agent-access-switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * Top-bar Database control: a split button whose left half toggles the Database surface
 * open/closed and whose right half opens a popover hosting the agent database-access
 * on/off gate. This mirrors its sibling {@link VaultControlButton} exactly — same
 * split-button + popover layout and the same shared {@link AgentAccessSwitch} — so the
 * gate is reachable without first opening the Database view. The gate ONLY governs
 * whether agents may run `kanban db` (read-only); the human Database view is never
 * affected by it.
 */
export function DatabaseControlButton({
	isDatabaseOpen,
	onToggleDatabase,
	agentDatabaseAccessEnabled,
	onAgentDatabaseAccessChange,
	settingsDisabled = false,
}: {
	isDatabaseOpen: boolean;
	onToggleDatabase: () => void;
	agentDatabaseAccessEnabled: boolean;
	onAgentDatabaseAccessChange: (next: boolean) => void;
	settingsDisabled?: boolean;
}): React.ReactElement {
	const [isPopoverOpen, setIsPopoverOpen] = useState(false);
	return (
		<div className={cn("flex shrink-0 rounded-md", isDatabaseOpen && "ring-1 ring-accent")}>
			<Button
				variant={isDatabaseOpen ? "primary" : "default"}
				size="sm"
				icon={<Database size={14} />}
				onClick={onToggleDatabase}
				className={cn("rounded-r-none", !isDatabaseOpen && "kb-navbar-btn")}
				title="Database"
			>
				Database
			</Button>
			<RadixPopover.Root open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
				<RadixPopover.Trigger asChild>
					<Button
						variant={isDatabaseOpen ? "primary" : "default"}
						size="sm"
						icon={<ChevronDown size={12} />}
						aria-label="Database settings"
						className={cn("rounded-l-none border-l-0", !isDatabaseOpen && "kb-navbar-btn")}
						style={{ width: 24, paddingLeft: 0, paddingRight: 0 }}
					/>
				</RadixPopover.Trigger>
				<RadixPopover.Portal>
					<RadixPopover.Content
						className="z-50 rounded-lg border border-border bg-surface-2 p-3 shadow-xl"
						style={{ animation: "kb-tooltip-show 100ms ease" }}
						sideOffset={5}
						align="start"
					>
						<div className="flex min-w-[280px] flex-col gap-3">
							<AgentAccessSwitch
								icon={
									<Database
										size={14}
										className={cn(
											"shrink-0",
											agentDatabaseAccessEnabled ? "text-accent" : "text-text-tertiary",
										)}
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
								disabled={settingsDisabled}
								onCheckedChange={onAgentDatabaseAccessChange}
							/>
						</div>
					</RadixPopover.Content>
				</RadixPopover.Portal>
			</RadixPopover.Root>
		</div>
	);
}
