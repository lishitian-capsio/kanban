// The left rail of the fullscreen Pi tab: pi's own session list.
//
// Lists every pi session (the pinned base + created pi threads), lets the user switch
// between them, create a new blank one ("+"), and hard-close a created one (gated by the
// shared confirm dialog). The status marker mirrors the launcher card's semantics, derived
// from the same per-session summary the rest of the app already streams. The base session
// (DEFAULT_HOME_THREAD_ID) is never closable.
import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import { Plus, X } from "lucide-react";
import { type ReactElement, useState } from "react";

import { deriveHomeSessionCardStatus } from "@/components/home-agent/home-session-card-derive";
import { HomeSessionCardStatusMarker } from "@/components/home-agent/home-session-card-status-marker";
import { HomeThreadCloseDialog } from "@/components/home-agent/home-thread-close-dialog";
import { cn } from "@/components/ui/cn";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

interface PiSessionRailProps {
	sessions: HomeThread[];
	activeId: string;
	currentProjectId: string;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onSelect: (threadId: string) => void;
	onCreate: () => void;
	onClose: (threadId: string) => void | Promise<void>;
}

export function PiSessionRail({
	sessions,
	activeId,
	currentProjectId,
	taskSessions,
	onSelect,
	onCreate,
	onClose,
}: PiSessionRailProps): ReactElement {
	const [closeTarget, setCloseTarget] = useState<HomeThread | null>(null);
	return (
		<div className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border pr-2">
			<button
				type="button"
				onClick={onCreate}
				className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:border-border-focus"
			>
				<Plus size={14} className="shrink-0" aria-hidden="true" />
				<span>New session</span>
			</button>
			{sessions.map((session) => {
				const taskId = createHomeAgentSessionId(currentProjectId, session.agentId, session.id);
				const status = deriveHomeSessionCardStatus(taskSessions[taskId] ?? null);
				const isActive = session.id === activeId;
				const label = session.name || "Untitled";
				return (
					<div
						key={session.id}
						className={cn(
							"group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
							isActive
								? "bg-surface-2 text-text-primary"
								: "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
						)}
					>
						<button
							type="button"
							onClick={() => onSelect(session.id)}
							title={label}
							className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-none"
						>
							<span
								className="flex size-4 shrink-0 items-center justify-center"
								role="img"
								aria-label={status.label}
								title={status.label}
							>
								<HomeSessionCardStatusMarker status={status} />
							</span>
							<span className={cn("min-w-0 truncate", isActive && "font-medium")}>{label}</span>
						</button>
						{!session.isDefault ? (
							<button
								type="button"
								aria-label={`Close ${label} session`}
								title="Close session"
								onClick={() => setCloseTarget(session)}
								className="shrink-0 cursor-pointer rounded-sm p-0.5 text-text-tertiary opacity-0 transition-opacity hover:bg-surface-4 hover:text-status-red focus-visible:opacity-100 group-hover:opacity-100"
							>
								<X size={13} />
							</button>
						) : null}
					</div>
				);
			})}
			<HomeThreadCloseDialog
				thread={closeTarget}
				onOpenChange={(open) => {
					if (!open) {
						setCloseTarget(null);
					}
				}}
				onClose={onClose}
			/>
		</div>
	);
}
