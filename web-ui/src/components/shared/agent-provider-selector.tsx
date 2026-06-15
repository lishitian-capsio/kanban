// Inline provider indicator for CLI agents in the settings dialog.
// In the per-agent model each agent has one independent provider config,
// so this shows the current provider name and lets the user open the
// add-provider dialog to configure or change it.
import { Key, Plus } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { fetchAgentProviderConfigs } from "@/runtime/runtime-config-query";
import type { RuntimeAgentProviderConfigListResponse } from "@/runtime/types";

interface AgentProviderSelectorProps {
	agentId: string;
	workspaceId: string | null;
	controlsDisabled?: boolean;
	onAddProvider?: () => void;
}

export function AgentProviderSelector({
	agentId,
	workspaceId,
	controlsDisabled = false,
	onAddProvider,
}: AgentProviderSelectorProps): ReactElement | null {
	const [configs, setConfigs] = useState<RuntimeAgentProviderConfigListResponse | null>(null);

	const load = useCallback(async () => {
		try {
			const c = await fetchAgentProviderConfigs(workspaceId);
			setConfigs(c);
		} catch {
			// silently fail — we'll just show nothing
		}
	}, [workspaceId]);

	useEffect(() => {
		void load();
	}, [load]);

	const config = configs?.agents[agentId] ?? null;
	const providerName = config?.provider?.trim() || null;

	if (!providerName && !onAddProvider) {
		return null;
	}

	return (
		<div className="flex items-center gap-1 ml-auto shrink-0" onClick={(e) => e.stopPropagation()}>
			<Key size={12} className="text-text-tertiary shrink-0" />
			{providerName ? (
				<Tooltip content="Configure provider in the Kanban tab">
					<span className="flex items-center gap-1 h-6 px-2 rounded-md text-[11px] text-text-secondary">
						<span className="max-w-[100px] truncate">{providerName}</span>
					</span>
				</Tooltip>
			) : onAddProvider ? (
				<Tooltip content="Add a provider">
					<Button
						size="sm"
						variant="ghost"
						disabled={controlsDisabled}
						icon={<Plus size={12} />}
						onClick={(e) => {
							e.stopPropagation();
							onAddProvider();
						}}
					>
						Add Provider
					</Button>
				</Tooltip>
			) : null}
		</div>
	);
}
