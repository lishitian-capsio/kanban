// A single session tile in the fullscreen Home-tab launcher.
//
// One card == one home chat thread. It carries the dashboard signal the decision
// asks for: agent identity, thread title, a status dot, the latest conversational
// line, and a last-activity timestamp — all derived from existing per-thread
// session/transcript state (see use-home-session-card / home-session-card-derive),
// adding no data model. Clicking it hands the thread id to `onOpenSession`.
//
// Beyond opening, the card mirrors the board task card's per-context affordances
// (board-card.tsx): a hover-revealed inline rename, a hover-revealed destructive
// close (gated by a confirm dialog), and a restart shown only for an errored
// session. Because the card hosts these nested interactive controls, the shell is
// a `role="button"` div (not a `<button>` — an `<input>`/`<button>` nested inside a
// real button is invalid DOM); each control stops propagation so acting on it never
// also triggers `onOpenSession`.
import { Bot, Pencil, RotateCcw, X } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
	deriveHomeSessionCardStatus,
	formatHomeSessionCardTimeAgo,
} from "@/components/home-agent/home-session-card-derive";
import { HomeSessionCardStatusMarker } from "@/components/home-agent/home-session-card-status-marker";
import { HomeThreadCloseDialog } from "@/components/home-agent/home-thread-close-dialog";
import { ThreadAgentBadge } from "@/components/home-agent/thread-agent-badge";
import { SessionMetaBadges } from "@/components/session-meta-badges";
import { cn } from "@/components/ui/cn";
import { useHomeSessionCard } from "@/hooks/use-home-session-card";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentDefinition, RuntimeTaskSessionSummary } from "@/runtime/types";
import { getCardSessionActivity } from "@/utils/session-activity";

interface HomeSessionCardProps {
	thread: HomeThread;
	taskId: string;
	agents: RuntimeAgentDefinition[];
	summary: RuntimeTaskSessionSummary | null;
	/** Whether this thread is currently open in a fullscreen session tab — drives the accent highlight. */
	isOpen: boolean;
	currentProjectId: string;
	onOpenSession: (threadId: string) => void;
	/** Rename the thread (registry rename). Not offered for the default thread. */
	onRename: (threadId: string, name: string) => void | Promise<void>;
	/** Hard-close the thread (stops the session + deletes the transcript). Not offered for the default thread. */
	onClose: (threadId: string) => void | Promise<void>;
	/** Re-launch the thread's agent session. Only surfaced when the session is in an error state. */
	onRestart: (threadId: string) => void | Promise<void>;
}

const ACTION_BUTTON_CLASS =
	"shrink-0 cursor-pointer rounded-sm p-1 text-text-tertiary opacity-0 transition-opacity hover:bg-surface-4 hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent group-hover:opacity-100";

export function HomeSessionCard({
	thread,
	taskId,
	agents,
	summary,
	isOpen,
	currentProjectId,
	onOpenSession,
	onRename,
	onClose,
	onRestart,
}: HomeSessionCardProps): React.ReactElement {
	const { preview, isLoadingHistory } = useHomeSessionCard(currentProjectId, taskId);
	const status = useMemo(() => deriveHomeSessionCardStatus(summary), [summary]);

	// While the session is live (running / awaiting review / errored) show the
	// same one-line agent-activity row the board task card surfaces — a colored
	// dot + truncated monospace text derived from the session summary. When the
	// session is settled/idle we fall back to the last conversational line so the
	// card still reads like "the last thing said". This complements the top-right
	// status dot rather than replacing the message preview.
	const liveActivity = useMemo(() => getCardSessionActivity(summary), [summary]);
	const showLiveActivity = status.status !== "idle" && liveActivity != null;

	// Last activity prefers the latest message; fall back to the session's own
	// updatedAt so a started-but-silent thread still reads as recently touched.
	const lastActivityAt = preview?.createdAt ?? summary?.lastOutputAt ?? summary?.updatedAt ?? null;
	const timeAgo = formatHomeSessionCardTimeAgo(lastActivityAt, Date.now());

	// The default thread is workspace-global and can't be renamed/closed (the
	// registry mutations early-return for it); only created threads get those.
	const canManage = !thread.isDefault;
	const canRestart = status.status === "error";

	const [isEditingName, setIsEditingName] = useState(false);
	const [draftName, setDraftName] = useState(thread.name);
	const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
	const nameInputRef = useRef<HTMLInputElement | null>(null);
	// Escape cancels by short-circuiting the blur-driven submit (mirrors board-card).
	const renameCancelledRef = useRef(false);

	useEffect(() => {
		setDraftName(thread.name);
		setIsEditingName(false);
	}, [thread.name]);

	useEffect(() => {
		if (!isEditingName) {
			return;
		}
		window.requestAnimationFrame(() => {
			nameInputRef.current?.focus();
			nameInputRef.current?.select();
		});
	}, [isEditingName]);

	const stopEvent = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	// Submission lives only here (blur), so Enter (which blurs) and a click-away
	// both route through one path — no double save.
	const submitName = () => {
		if (renameCancelledRef.current) {
			renameCancelledRef.current = false;
			return;
		}
		setIsEditingName(false);
		const trimmed = draftName.trim();
		if (!trimmed || trimmed === thread.name) {
			return;
		}
		void onRename(thread.id, trimmed);
	};

	const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			nameInputRef.current?.blur();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			renameCancelledRef.current = true;
			setDraftName(thread.name);
			setIsEditingName(false);
			nameInputRef.current?.blur();
		}
	};

	const openSession = () => {
		if (!isEditingName) {
			onOpenSession(thread.id);
		}
	};

	return (
		<div
			role="button"
			tabIndex={0}
			aria-label={`Open ${thread.name} session`}
			data-open={isOpen}
			onClick={(event) => {
				const target = event.target as HTMLElement | null;
				// Clicks on the nested controls (rename/close/restart, the edit input) must
				// not also open the session.
				if (target?.closest("button, a, input, textarea")) {
					return;
				}
				openSession();
			}}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget) {
					return;
				}
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					openSession();
				}
			}}
			className={cn(
				"group flex h-40 cursor-pointer flex-col gap-2 rounded-lg border bg-surface-2 p-3 text-left transition-colors hover:bg-surface-3 focus:outline-none focus-visible:border-border-focus",
				// An "already open" thread gets the board task card's accent highlight so the
				// launcher reads which conversations are live in a tab. The accent border wins
				// over hover so the highlight is stable while pointing at the card.
				isOpen ? "border-accent hover:border-accent" : "border-border hover:border-border-bright",
			)}
		>
			<div className="flex items-center gap-2">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-1 text-text-secondary">
					<Bot size={16} aria-hidden="true" />
				</span>
				{isEditingName ? (
					<input
						ref={nameInputRef}
						value={draftName}
						onChange={(event) => setDraftName(event.currentTarget.value)}
						onBlur={submitName}
						onKeyDown={handleNameKeyDown}
						onClick={stopEvent}
						onMouseDown={(event) => event.stopPropagation()}
						aria-label={`Rename ${thread.name} session`}
						className="h-7 min-w-0 flex-1 rounded-md border border-border-focus bg-surface-2 px-2 text-[13px] font-medium text-text-primary focus:outline-none"
					/>
				) : (
					<div className="flex min-w-0 flex-1 items-center gap-1">
						<span className="min-w-0 truncate text-[13px] font-medium text-text-primary">{thread.name}</span>
						{canManage ? (
							<button
								type="button"
								aria-label={`Rename ${thread.name} session`}
								title="Rename"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									setDraftName(thread.name);
									setIsEditingName(true);
								}}
								className={ACTION_BUTTON_CLASS}
							>
								<Pencil size={12} />
							</button>
						) : null}
					</div>
				)}
				<span className="flex shrink-0 items-center gap-0.5">
					{canRestart ? (
						<button
							type="button"
							aria-label={`Restart ${thread.name} session`}
							title="Restart session"
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								void onRestart(thread.id);
							}}
							className={cn(ACTION_BUTTON_CLASS, "hover:text-status-blue")}
						>
							<RotateCcw size={12} />
						</button>
					) : null}
					{canManage ? (
						<button
							type="button"
							aria-label={`Close ${thread.name} session`}
							title="Close session"
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								setIsCloseDialogOpen(true);
							}}
							className={cn(ACTION_BUTTON_CLASS, "hover:text-status-red")}
						>
							<X size={12} />
						</button>
					) : null}
					<span
						className="flex size-4 shrink-0 items-center justify-center"
						role="img"
						aria-label={status.label}
						title={status.label}
					>
						<HomeSessionCardStatusMarker status={status} />
					</span>
				</span>
			</div>

			<div className="min-h-0 flex-1 overflow-hidden text-[12px] leading-snug">
				{showLiveActivity && liveActivity ? (
					<div className="flex items-start gap-1.5" role="status" aria-label="Agent activity">
						<span
							className="mt-[3px] inline-block size-1.5 shrink-0 rounded-full"
							style={{ backgroundColor: liveActivity.dotColor }}
						/>
						<p className="m-0 min-w-0 flex-1 truncate font-mono text-text-secondary">{liveActivity.text}</p>
					</div>
				) : isLoadingHistory && !preview ? (
					<div className="flex flex-col gap-1.5 pt-0.5" aria-hidden="true">
						<span className="h-2.5 w-full animate-pulse rounded-full bg-surface-4" />
						<span className="h-2.5 w-4/5 animate-pulse rounded-full bg-surface-4" />
					</div>
				) : preview ? (
					<p className="line-clamp-3 text-text-secondary">
						<span className="text-text-tertiary">{preview.role === "user" ? "You: " : "Agent: "}</span>
						{preview.text}
					</p>
				) : (
					<p className="text-text-tertiary italic">No messages yet</p>
				)}
			</div>

			{/* Live session provider/model + cumulative token usage, sourced from the
			    same summary that drives the status dot. Renders nothing until the
			    session has run (and tokens only for agents with telemetry). */}
			<SessionMetaBadges summary={summary} />

			<div className="flex items-center justify-between gap-2">
				<ThreadAgentBadge agents={agents} agentId={thread.agentId} />
				{timeAgo ? <span className="shrink-0 text-[11px] text-text-tertiary">{timeAgo}</span> : null}
			</div>

			<HomeThreadCloseDialog
				thread={isCloseDialogOpen ? thread : null}
				onOpenChange={(open) => {
					if (!open) {
						setIsCloseDialogOpen(false);
					}
				}}
				onClose={onClose}
			/>
		</div>
	);
}
