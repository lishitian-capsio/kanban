// The permanent "+" tile fixed last in the Home-tab launcher grid.
//
// Browser-new-tab idiom: a dashed placeholder that opens the existing thread
// create dialog (same agent picker / kickoff prompt as the compact thread bar),
// so adding a session has zero new surface to learn. It owns only the dialog's
// open state; thread creation itself flows through the shared registry hook.
import { Plus } from "lucide-react";
import { useState } from "react";

import { HomeThreadCreateDialog } from "@/components/home-agent/home-thread-create-dialog";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";

interface HomeAddSessionCardProps {
	agents: RuntimeAgentDefinition[];
	defaultAgentId: RuntimeAgentId;
	onCreate: (input: { description: string; agentId: RuntimeAgentId }) => void | Promise<void>;
}

export function HomeAddSessionCard({ agents, defaultAgentId, onCreate }: HomeAddSessionCardProps): React.ReactElement {
	const [createOpen, setCreateOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				onClick={() => setCreateOpen(true)}
				className="group flex h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-bright bg-transparent p-3 text-text-secondary transition-colors hover:border-accent hover:bg-surface-2 hover:text-text-primary focus:outline-none focus-visible:border-border-focus"
				aria-label="New chat session"
			>
				<span className="flex size-9 items-center justify-center rounded-full border border-border-bright bg-surface-2 transition-colors group-hover:border-accent">
					<Plus size={18} aria-hidden="true" />
				</span>
				<span className="text-[13px] font-medium">New session</span>
			</button>
			<HomeThreadCreateDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				agents={agents}
				defaultAgentId={defaultAgentId}
				onCreate={onCreate}
			/>
		</>
	);
}
