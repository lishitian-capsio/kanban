import * as RadixPopover from "@radix-ui/react-popover";
import { ChevronDown, Library, Sparkles } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { AgentAccessSwitch } from "@/components/ui/agent-access-switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * Top-bar Vault control: a split button whose left half toggles the vault surface
 * open/closed (matching its sibling Database button) and whose right half opens a
 * popover hosting the agent vault-management on/off switch. Folding it in here keeps
 * it reachable without first opening the vault. The switch is the shared
 * {@link AgentAccessSwitch}, so it matches the Database access toggle exactly. (The
 * agent database-access gate itself lives in the Database view, next to the surface
 * it governs.)
 */
export function VaultControlButton({
	isVaultOpen,
	onToggleVault,
	agentVaultManagementEnabled,
	onAgentVaultManagementChange,
	settingsDisabled = false,
}: {
	isVaultOpen: boolean;
	onToggleVault: () => void;
	agentVaultManagementEnabled: boolean;
	onAgentVaultManagementChange: (next: boolean) => void;
	settingsDisabled?: boolean;
}): React.ReactElement {
	const [isPopoverOpen, setIsPopoverOpen] = useState(false);
	return (
		<div className={cn("flex shrink-0 rounded-md", isVaultOpen && "ring-1 ring-accent")}>
			<Button
				variant={isVaultOpen ? "primary" : "default"}
				size="sm"
				icon={<Library size={14} />}
				onClick={onToggleVault}
				className={cn("rounded-r-none", !isVaultOpen && "kb-navbar-btn")}
				title="Vault"
			>
				Vault
			</Button>
			<RadixPopover.Root open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
				<RadixPopover.Trigger asChild>
					<Button
						variant={isVaultOpen ? "primary" : "default"}
						size="sm"
						icon={<ChevronDown size={12} />}
						aria-label="Vault settings"
						className={cn("rounded-l-none border-l-0", !isVaultOpen && "kb-navbar-btn")}
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
									<Sparkles
										size={14}
										className={cn(
											"shrink-0",
											agentVaultManagementEnabled ? "text-accent" : "text-text-tertiary",
										)}
									/>
								}
								label="Allow agents to manage vault documents"
								description={
									agentVaultManagementEnabled
										? "Agents see the vault CLI and document types, and may proactively create and maintain documents."
										: "Agents can't use the vault — no vault guidance is injected at all."
								}
								checked={agentVaultManagementEnabled}
								disabled={settingsDisabled}
								onCheckedChange={onAgentVaultManagementChange}
							/>
						</div>
					</RadixPopover.Content>
				</RadixPopover.Portal>
			</RadixPopover.Root>
		</div>
	);
}
