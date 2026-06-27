// Compact thread switcher for the sidebar home agent panel.
//
// A header bar shows the active thread (name + agent badge) and opens a dropdown
// listing every parallel thread. The default thread is always present and cannot
// be renamed or closed; created threads expose rename/close affordances. A "+"
// button creates a new thread with its own agent.

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Pencil, Plus, X } from "lucide-react";
import { useState } from "react";

import { HomeThreadCloseDialog } from "@/components/home-agent/home-thread-close-dialog";
import { HomeThreadCreateDialog } from "@/components/home-agent/home-thread-create-dialog";
import { HomeThreadRenameDialog } from "@/components/home-agent/home-thread-rename-dialog";
import { ThreadAgentBadge } from "@/components/home-agent/thread-agent-badge";
import { cn } from "@/components/ui/cn";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";

interface HomeThreadBarProps {
	threads: HomeThread[];
	activeThreadId: string;
	agents: RuntimeAgentDefinition[];
	defaultAgentId: RuntimeAgentId;
	onSelectThread: (threadId: string) => void;
	onCreateThread: (input: { description: string; agentId: RuntimeAgentId }) => void | Promise<unknown>;
	onRenameThread: (threadId: string, name: string) => void | Promise<void>;
	onCloseThread: (threadId: string) => void | Promise<void>;
}

export function HomeThreadBar({
	threads,
	activeThreadId,
	agents,
	defaultAgentId,
	onSelectThread,
	onCreateThread,
	onRenameThread,
	onCloseThread,
}: HomeThreadBarProps): React.ReactElement | null {
	const [menuOpen, setMenuOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [renameTarget, setRenameTarget] = useState<HomeThread | null>(null);
	const [closeTarget, setCloseTarget] = useState<HomeThread | null>(null);

	const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? threads[0] ?? null;
	if (!activeThread) {
		return null;
	}

	return (
		<div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-2 p-1">
			<DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-text-primary outline-none hover:bg-surface-3 data-[state=open]:bg-surface-3"
						aria-label="Switch chat thread"
					>
						<ChevronDown size={14} className="shrink-0 text-text-secondary" />
						<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{activeThread.name}</span>
						<ThreadAgentBadge agents={agents} agentId={activeThread.agentId} />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						side="bottom"
						align="start"
						sideOffset={4}
						className="z-50 max-h-[60vh] w-[var(--radix-dropdown-menu-trigger-width)] min-w-[200px] overflow-y-auto rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
						onCloseAutoFocus={(event) => event.preventDefault()}
					>
						{threads.map((thread) => {
							const isActive = thread.id === activeThread.id;
							return (
								<DropdownMenu.Item
									key={thread.id}
									className={cn(
										"flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-3",
										isActive ? "text-text-primary" : "text-text-secondary",
									)}
									onSelect={() => onSelectThread(thread.id)}
								>
									<Check size={14} className={cn("shrink-0", isActive ? "text-accent" : "opacity-0")} />
									<span className="min-w-0 flex-1 truncate">{thread.name}</span>
									<ThreadAgentBadge agents={agents} agentId={thread.agentId} />
									{thread.isDefault ? null : (
										<span className="flex shrink-0 items-center gap-0.5">
											<button
												type="button"
												aria-label="Rename thread"
												className="cursor-pointer rounded-sm p-1 text-text-tertiary hover:bg-surface-4 hover:text-text-primary"
												onClick={(event) => {
													event.stopPropagation();
													setMenuOpen(false);
													setRenameTarget(thread);
												}}
											>
												<Pencil size={12} />
											</button>
											<button
												type="button"
												aria-label="Close thread"
												className="cursor-pointer rounded-sm p-1 text-text-tertiary hover:bg-surface-4 hover:text-status-red"
												onClick={(event) => {
													event.stopPropagation();
													setMenuOpen(false);
													setCloseTarget(thread);
												}}
											>
												<X size={12} />
											</button>
										</span>
									)}
								</DropdownMenu.Item>
							);
						})}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			<button
				type="button"
				aria-label="New chat thread"
				className="flex shrink-0 cursor-pointer items-center rounded-sm p-1.5 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
				onClick={() => setCreateOpen(true)}
			>
				<Plus size={14} />
			</button>

			<HomeThreadCreateDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				agents={agents}
				defaultAgentId={defaultAgentId}
				onCreate={onCreateThread}
			/>
			<HomeThreadRenameDialog
				thread={renameTarget}
				onOpenChange={(open) => {
					if (!open) {
						setRenameTarget(null);
					}
				}}
				onRename={onRenameThread}
			/>
			<HomeThreadCloseDialog
				thread={closeTarget}
				onOpenChange={(open) => {
					if (!open) {
						setCloseTarget(null);
					}
				}}
				onClose={onCloseThread}
			/>
		</div>
	);
}
