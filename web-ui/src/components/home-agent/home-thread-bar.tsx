// Compact thread switcher for the sidebar home agent panel.
//
// A header bar shows the active thread (name + agent badge) and opens a dropdown
// listing every parallel thread. The default thread is always present and cannot
// be renamed or closed; created threads expose rename/close affordances. A "+"
// button creates a new thread with its own agent.

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import { ChevronDown, Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { deriveHomeSessionCardStatus } from "@/components/home-agent/home-session-card-derive";
import { HomeThreadCloseDialog } from "@/components/home-agent/home-thread-close-dialog";
import { HomeThreadCreateDialog } from "@/components/home-agent/home-thread-create-dialog";
import { HomeThreadRenameDialog } from "@/components/home-agent/home-thread-rename-dialog";
import { getActiveHighlightClass } from "@/components/home-agent/session-active-highlight";
import { SessionAgentIdentity } from "@/components/home-agent/session-agent-identity";
import { cn } from "@/components/ui/cn";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TaskImage } from "@/types";

interface HomeThreadBarProps {
	threads: HomeThread[];
	activeThreadId: string;
	agents: RuntimeAgentDefinition[];
	defaultAgentId: RuntimeAgentId;
	/** Workspace id used to resolve each thread's session id for its status dot. */
	currentProjectId: string;
	/** Per-session summaries that drive each row's status badge (rule 1: the dropdown now shows status). */
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onSelectThread: (threadId: string) => void;
	onCreateThread: (input: {
		threadId: string;
		description: string;
		agentId: RuntimeAgentId;
		images?: TaskImage[];
	}) => void | Promise<unknown>;
	onRenameThread: (threadId: string, name: string) => void | Promise<void>;
	onCloseThread: (threadId: string) => void | Promise<void>;
}

export function HomeThreadBar({
	threads,
	activeThreadId,
	agents,
	defaultAgentId,
	currentProjectId,
	taskSessions,
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

	const statusFor = (thread: HomeThread) =>
		deriveHomeSessionCardStatus(
			taskSessions[createHomeAgentSessionId(currentProjectId, thread.agentId, thread.id)] ?? null,
		);

	return (
		<div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-2 p-1">
			<DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-left outline-none hover:bg-surface-3 data-[state=open]:bg-surface-3"
						aria-label="Switch chat thread"
					>
						{/* The trigger shows the active thread with the same avatar + status + title
						    atom as the menu rows, so the compact switcher reads its agent and health
						    at a glance without opening (rule 1). */}
						<SessionAgentIdentity
							agents={agents}
							agentId={activeThread.agentId}
							status={statusFor(activeThread)}
							title={activeThread.name}
							isActive
							variant="dropdown-item"
							className="flex-1"
						/>
						<ChevronDown size={14} className="shrink-0 text-text-secondary" />
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
										"flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1.5 outline-none data-[highlighted]:bg-surface-3",
										// Active row uses the unified accent signal (left bar + surface-2),
										// replacing the old checkmark (rule 2).
										getActiveHighlightClass("dropdown-item", isActive),
									)}
									onSelect={() => onSelectThread(thread.id)}
								>
									<SessionAgentIdentity
										agents={agents}
										agentId={thread.agentId}
										status={statusFor(thread)}
										title={thread.name}
										isActive={isActive}
										variant="dropdown-item"
										className="flex-1"
									/>
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
				workspaceId={currentProjectId}
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
