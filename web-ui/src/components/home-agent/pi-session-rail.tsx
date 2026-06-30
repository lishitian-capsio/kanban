// Pi's session list — the single management surface for pi sessions, used identically in
// board (docked) mode and session (fullscreen) mode.
//
// Lists every pi session (created pi threads), lets the user switch between them, create a
// new blank one ("+"), rename one, and hard-close one (gated by the shared confirm dialog).
// The status marker mirrors the launcher card's semantics, derived from the same per-session
// summary the rest of the app already streams. Every listed session is a real, closeable
// thread (the synthetic default is excluded from pi sessions — see pi-sessions.ts).
//
// The rail has two presentations driven by `collapsed`: an expanded list (fullscreen, or the
// docked sidebar once expanded) and a narrow icon-only strip (the docked default, since a full
// 208px rail leaves no room beside the conversation in a 280px-min sidebar). Both render the
// same agent avatar + status badge so a session reads identically in either form.
import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import { PanelLeftClose, PanelLeftOpen, Pencil, Plus, X } from "lucide-react";
import { type ReactElement, useState } from "react";

import { AgentAvatar } from "@/components/home-agent/agent-icon";
import { deriveHomeSessionCardStatus } from "@/components/home-agent/home-session-card-derive";
import { HomeSessionCardStatusMarker } from "@/components/home-agent/home-session-card-status-marker";
import { HomeThreadCloseDialog } from "@/components/home-agent/home-thread-close-dialog";
import { HomeThreadRenameDialog } from "@/components/home-agent/home-thread-rename-dialog";
import { getActiveHighlightClass } from "@/components/home-agent/session-active-highlight";
import { SessionAgentIdentity } from "@/components/home-agent/session-agent-identity";
import { cn } from "@/components/ui/cn";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentDefinition, RuntimeTaskSessionSummary } from "@/runtime/types";
import { deriveSessionShortId } from "@/utils/session-short-id";

interface PiSessionRailProps {
	sessions: HomeThread[];
	/** The selected pi session, or null when none is focused (no row highlighted). */
	activeId: string | null;
	currentProjectId: string;
	/** Agent catalog — the rail renders the agent avatar + status badge for each session. */
	agents: RuntimeAgentDefinition[];
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onSelect: (threadId: string) => void;
	onCreate: () => void;
	onClose: (threadId: string) => void | Promise<void>;
	onRename: (threadId: string, name: string) => void | Promise<void>;
	/** When true the rail can collapse to a narrow icon strip (the docked-sidebar affordance). */
	collapsible?: boolean;
	/** Whether the rail is currently collapsed (only meaningful with `collapsible`). */
	collapsed?: boolean;
	/** Toggle the collapsed state. */
	onToggleCollapsed?: () => void;
}

export function PiSessionRail({
	sessions,
	activeId,
	currentProjectId,
	agents,
	taskSessions,
	onSelect,
	onCreate,
	onClose,
	onRename,
	collapsible = false,
	collapsed = false,
	onToggleCollapsed,
}: PiSessionRailProps): ReactElement {
	const [closeTarget, setCloseTarget] = useState<HomeThread | null>(null);
	const [renameTarget, setRenameTarget] = useState<HomeThread | null>(null);

	const statusFor = (session: HomeThread) =>
		deriveHomeSessionCardStatus(
			taskSessions[createHomeAgentSessionId(currentProjectId, session.agentId, session.id)] ?? null,
		);

	const dialogs = (
		<>
			<HomeThreadRenameDialog
				thread={renameTarget}
				onOpenChange={(open) => {
					if (!open) {
						setRenameTarget(null);
					}
				}}
				onRename={onRename}
			/>
			<HomeThreadCloseDialog
				thread={closeTarget}
				onOpenChange={(open) => {
					if (!open) {
						setCloseTarget(null);
					}
				}}
				onClose={onClose}
			/>
		</>
	);

	if (collapsed) {
		return (
			<div className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border pr-1">
				{collapsible ? (
					<button
						type="button"
						onClick={onToggleCollapsed}
						aria-label="Expand pi sessions"
						title="Expand pi sessions"
						className="flex shrink-0 cursor-pointer items-center justify-center rounded-md p-1.5 text-text-secondary outline-none transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:border-border-focus"
					>
						<PanelLeftOpen size={14} aria-hidden="true" />
					</button>
				) : null}
				<button
					type="button"
					onClick={onCreate}
					aria-label="New pi session"
					title="New session"
					className="flex shrink-0 cursor-pointer items-center justify-center rounded-md p-1.5 text-text-secondary outline-none transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:border-border-focus"
				>
					<Plus size={14} aria-hidden="true" />
				</button>
				{sessions.map((session) => {
					const isActive = session.id === activeId;
					const label = session.name || "Untitled";
					return (
						<button
							key={session.id}
							type="button"
							onClick={() => onSelect(session.id)}
							title={label}
							aria-label={`Open ${label} session`}
							aria-pressed={isActive}
							className={cn(
								"flex shrink-0 cursor-pointer items-center justify-center rounded-md p-1 outline-none transition-colors focus-visible:border-border-focus",
								getActiveHighlightClass("rail-item", isActive),
							)}
						>
							<AgentAvatar agents={agents} agentId={session.agentId}>
								<span
									className="absolute -bottom-1 -right-1 inline-flex items-center justify-center rounded-full bg-surface-1"
									role="img"
									aria-label={statusFor(session).label}
									title={statusFor(session).label}
								>
									<HomeSessionCardStatusMarker status={statusFor(session)} />
								</span>
							</AgentAvatar>
						</button>
					);
				})}
				{dialogs}
			</div>
		);
	}

	return (
		<div className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border pr-2">
			<div className="flex shrink-0 items-center gap-1">
				<button
					type="button"
					onClick={onCreate}
					className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:border-border-focus"
				>
					<Plus size={14} className="shrink-0" aria-hidden="true" />
					<span>New session</span>
				</button>
				{collapsible ? (
					<button
						type="button"
						onClick={onToggleCollapsed}
						aria-label="Collapse pi sessions"
						title="Collapse pi sessions"
						className="flex shrink-0 cursor-pointer items-center justify-center rounded-md p-1.5 text-text-tertiary outline-none transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:border-border-focus"
					>
						<PanelLeftClose size={14} aria-hidden="true" />
					</button>
				) : null}
			</div>
			{sessions.map((session) => {
				const taskId = createHomeAgentSessionId(currentProjectId, session.agentId, session.id);
				const status = deriveHomeSessionCardStatus(taskSessions[taskId] ?? null);
				const isActive = session.id === activeId;
				const label = session.name || "Untitled";
				const shortId = deriveSessionShortId(taskId);
				return (
					<div
						key={session.id}
						className={cn(
							"group flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors",
							getActiveHighlightClass("rail-item", isActive),
						)}
					>
						<button
							type="button"
							onClick={() => onSelect(session.id)}
							title={label}
							className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-none"
						>
							{/* Unified identity atom: agent avatar leading, status badge on its corner. */}
							<SessionAgentIdentity
								agents={agents}
								agentId={session.agentId}
								status={status}
								title={label}
								isActive={isActive}
								variant="rail-item"
								className="min-w-0 flex-1"
							/>
							{/* Stable session short id — same code shown on the launcher card. */}
							<span
								className="shrink-0 font-mono text-[10px] leading-none text-text-tertiary"
								title={`Session ID: #${shortId}`}
							>
								#{shortId}
							</span>
						</button>
						<button
							type="button"
							aria-label={`Rename ${label} session`}
							title="Rename session"
							onClick={() => setRenameTarget(session)}
							className="shrink-0 cursor-pointer rounded-sm p-0.5 text-text-tertiary opacity-0 transition-opacity hover:bg-surface-4 hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
						>
							<Pencil size={12} />
						</button>
						<button
							type="button"
							aria-label={`Close ${label} session`}
							title="Close session"
							onClick={() => setCloseTarget(session)}
							className="shrink-0 cursor-pointer rounded-sm p-0.5 text-text-tertiary opacity-0 transition-opacity hover:bg-surface-4 hover:text-status-red focus-visible:opacity-100 group-hover:opacity-100"
						>
							<X size={13} />
						</button>
					</div>
				);
			})}
			{dialogs}
		</div>
	);
}
