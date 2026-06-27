// A single session tile in the fullscreen Home-tab launcher.
//
// One card == one home chat thread. It carries the dashboard signal the decision
// asks for: agent identity, thread title, a status dot, the latest conversational
// line, and a last-activity timestamp — all derived from existing per-thread
// session/transcript state (see use-home-session-card / home-session-card-derive),
// adding no data model. Clicking it hands the thread id to `onOpenSession`; the
// session-tab wiring that consumes it lands in a follow-up task.
import { Bot } from "lucide-react";
import { useMemo } from "react";

import {
	deriveHomeSessionCardStatus,
	formatHomeSessionCardTimeAgo,
} from "@/components/home-agent/home-session-card-derive";
import { ThreadAgentBadge } from "@/components/home-agent/thread-agent-badge";
import { cn } from "@/components/ui/cn";
import { useHomeSessionCard } from "@/hooks/use-home-session-card";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentDefinition, RuntimeTaskSessionSummary } from "@/runtime/types";

interface HomeSessionCardProps {
	thread: HomeThread;
	taskId: string;
	agents: RuntimeAgentDefinition[];
	summary: RuntimeTaskSessionSummary | null;
	currentProjectId: string;
	onOpenSession: (threadId: string) => void;
}

export function HomeSessionCard({
	thread,
	taskId,
	agents,
	summary,
	currentProjectId,
	onOpenSession,
}: HomeSessionCardProps): React.ReactElement {
	const { preview, isLoadingHistory } = useHomeSessionCard(currentProjectId, taskId);
	const status = useMemo(() => deriveHomeSessionCardStatus(summary), [summary]);

	// Last activity prefers the latest message; fall back to the session's own
	// updatedAt so a started-but-silent thread still reads as recently touched.
	const lastActivityAt = preview?.createdAt ?? summary?.lastOutputAt ?? summary?.updatedAt ?? null;
	const timeAgo = formatHomeSessionCardTimeAgo(lastActivityAt, Date.now());

	return (
		<button
			type="button"
			onClick={() => onOpenSession(thread.id)}
			className="group flex h-40 cursor-pointer flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3 text-left transition-colors hover:border-border-bright hover:bg-surface-3 focus:outline-none focus-visible:border-border-focus"
			aria-label={`Open ${thread.name} session`}
		>
			<div className="flex items-center gap-2">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-1 text-text-secondary">
					<Bot size={16} aria-hidden="true" />
				</span>
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">{thread.name}</span>
				<span
					className={cn("size-2 shrink-0 rounded-full", status.dotClassName, status.pulse && "animate-pulse")}
					role="img"
					aria-label={status.label}
					title={status.label}
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-hidden text-[12px] leading-snug">
				{isLoadingHistory && !preview ? (
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

			<div className="flex items-center justify-between gap-2">
				<ThreadAgentBadge agents={agents} agentId={thread.agentId} />
				{timeAgo ? <span className="shrink-0 text-[11px] text-text-tertiary">{timeAgo}</span> : null}
			</div>
		</button>
	);
}
