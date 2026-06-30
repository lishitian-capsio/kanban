import * as RadixPopover from "@radix-ui/react-popover";
import { ChevronDown, Library } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { VaultModeSelect } from "@/components/vault/vault-mode-select";
import type { RuntimeVaultMode } from "@/runtime/types";

/**
 * Top-bar Vault control: a split button whose left half toggles the vault surface
 * open/closed (matching its sibling Database button) and whose right half opens a
 * popover hosting the agent vault-management mode picker. Folding it in here keeps it
 * reachable without first opening the vault. (The agent database-access gate lives in
 * the Database view, next to the surface it governs.)
 */
export function VaultControlButton({
	isVaultOpen,
	onToggleVault,
	vaultMode,
	onVaultModeChange,
	settingsDisabled = false,
}: {
	isVaultOpen: boolean;
	onToggleVault: () => void;
	vaultMode: RuntimeVaultMode;
	onVaultModeChange: (next: RuntimeVaultMode) => void;
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
							<VaultModeSelect mode={vaultMode} onChange={onVaultModeChange} disabled={settingsDisabled} />
						</div>
					</RadixPopover.Content>
				</RadixPopover.Portal>
			</RadixPopover.Root>
		</div>
	);
}
