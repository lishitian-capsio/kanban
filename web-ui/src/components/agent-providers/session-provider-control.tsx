// The composer's inline provider switch, scoped to one agent + one session.
//
// Selecting a provider here is a pure *session-level override*: it pins which of
// the agent's registered providers this session launches with. It does NOT change
// the agent's default provider and does NOT touch any other running session — the
// owner keeps the selection per-thread and passes it only when the session next
// starts. It is select-only: providers are defined, edited, and defaulted in
// Settings → Agent, never here.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Server } from "lucide-react";
import { type ReactElement, useState } from "react";

import { cn } from "@/components/ui/cn";
import { providerIdOfConfig, useAgentProviderSet } from "@/hooks/use-agent-provider-set";

export interface SessionProviderControlProps {
	workspaceId: string | null;
	agentId: string | null;
	/** The provider id selected for this session; falls back to the agent default. */
	selectedProviderId: string | null;
	onSelectProvider: (providerId: string) => void;
	disabled?: boolean;
}

export function SessionProviderControl({
	workspaceId,
	agentId,
	selectedProviderId,
	onSelectProvider,
	disabled = false,
}: SessionProviderControlProps): ReactElement | null {
	const [open, setOpen] = useState(false);
	const { providers, defaultProviderId, isLoading } = useAgentProviderSet({
		workspaceId,
		agentId,
		enabled: agentId !== null,
	});

	if (agentId === null) {
		return null;
	}

	// The effective selection: the explicit per-session pick, else the agent default.
	const effectiveProviderId = selectedProviderId?.trim() || defaultProviderId || "";
	const triggerLabel = isLoading ? "Loading providers…" : effectiveProviderId || "No provider";

	const close = (): void => setOpen(false);

	return (
		<DropdownMenu.Root open={open} onOpenChange={setOpen}>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					disabled={disabled}
					aria-label="Switch session provider"
					className="flex min-w-0 max-w-[180px] cursor-pointer items-center gap-1.5 rounded-md bg-surface-3 px-2 py-1 text-left text-[13px] text-text-secondary outline-none hover:bg-surface-4 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-surface-4 data-[state=open]:text-text-primary"
				>
					<Server size={13} className="shrink-0" />
					<span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
					<ChevronDown size={13} className="shrink-0" />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					side="top"
					align="start"
					sideOffset={4}
					className="z-50 max-h-[60vh] w-[260px] overflow-y-auto rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
					onCloseAutoFocus={(event) => event.preventDefault()}
				>
					<div className="px-1.5 py-1 text-[11px] font-medium uppercase tracking-[0.02em] text-text-tertiary">
						Provider for this session
					</div>
					{providers.length === 0 ? (
						<div className="px-1.5 py-1.5 text-[13px] text-text-tertiary">
							{isLoading ? "Loading…" : "No providers — add one in Settings → Agent"}
						</div>
					) : (
						providers.map((provider) => {
							const providerId = providerIdOfConfig(provider);
							const isActive = providerId === effectiveProviderId;
							const isDefault = providerId === defaultProviderId;
							return (
								<DropdownMenu.Item
									key={providerId}
									className={cn(
										"flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-3",
										isActive ? "text-text-primary" : "text-text-secondary",
									)}
									onSelect={(event) => {
										event.preventDefault();
										onSelectProvider(providerId);
										close();
									}}
								>
									<Check size={14} className={cn("shrink-0", isActive ? "text-accent" : "opacity-0")} />
									<span className="min-w-0 flex-1 truncate">{providerId}</span>
									{isDefault ? (
										<span className="shrink-0 rounded-sm bg-surface-3 px-1 py-0.5 text-[10px] uppercase tracking-[0.02em] text-text-tertiary">
											Default
										</span>
									) : null}
								</DropdownMenu.Item>
							);
						})
					)}
					<div className="my-1 border-t border-border" />
					<div className="px-1.5 py-1 text-[11px] text-text-tertiary">
						Applies to this session on next start. Manage providers in Settings → Agent.
					</div>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
