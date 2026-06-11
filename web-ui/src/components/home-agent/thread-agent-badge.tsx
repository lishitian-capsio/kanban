import { cn } from "@/components/ui/cn";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";

export function resolveAgentLabel(agents: RuntimeAgentDefinition[], agentId: RuntimeAgentId): string {
	return agents.find((agent) => agent.id === agentId)?.label ?? agentId;
}

/** Compact chip showing which agent backs a home chat thread. */
export function ThreadAgentBadge({
	agents,
	agentId,
	className,
}: {
	agents: RuntimeAgentDefinition[];
	agentId: RuntimeAgentId;
	className?: string;
}): React.ReactElement {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded-sm border border-border bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary",
				className,
			)}
		>
			{resolveAgentLabel(agents, agentId)}
		</span>
	);
}
