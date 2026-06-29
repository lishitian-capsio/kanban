// The fullscreen Task tab: a lean, read-only tracker of tasks (decision e3134 /
// fullscreen-task-tab-direction).
//
// It replaces the previous "shell out to `task list` and read a CLI snapshot"
// workflow with a live, push-driven list. It is deliberately NOT a board mirror:
// no columns grid, no card grid, no drag, no write actions. It surfaces two
// clearly-separated groups so the user never confuses what's running with what's
// merely queued:
//   - Active   — the `in_progress` column (who's running) above the `review`
//                column (who's waiting on me).
//   - Backlog  — the `backlog` column (queued, not yet started).
// Each row reuses the SAME status-dot semantics and live agent-activity line as
// the fullscreen session cards (home-session-card-derive / session-activity).
// Clicking any row jumps into that task's detail/transcript via `onOpenTask` (the
// caller exits fullscreen so the task detail view — which renders below the
// fullscreen overlay — becomes visible), so the interaction is identical for
// active and backlog tasks.
//
// Following the granular-store convention, this leaf subscribes to the
// workspace-state slice itself (board + sessions) rather than receiving it from a
// higher-level hook, so only this panel re-renders as task activity streams in.
import { ListChecks } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo } from "react";

import {
	type TaskTabEntry,
	selectActiveTasks,
	selectBacklogTasks,
} from "@/components/home-agent/active-task-list-derive";
import { deriveHomeSessionCardStatus, formatHomeSessionCardTimeAgo } from "@/components/home-agent/home-session-card-derive";
import { HomeSessionCardStatusMarker } from "@/components/home-agent/home-session-card-status-marker";
import { ThreadAgentBadge } from "@/components/home-agent/thread-agent-badge";
import { useRuntimeWorkspaceState } from "@/runtime/runtime-stream-store";
import type { RuntimeAgentDefinition } from "@/runtime/types";
import { getCardSessionActivity } from "@/utils/session-activity";

interface ActiveTaskListProps {
	agents: RuntimeAgentDefinition[];
	/** Open the task's detail/transcript. The caller is responsible for exiting fullscreen. */
	onOpenTask: (taskId: string) => void;
}

export function ActiveTaskList({ agents, onOpenTask }: ActiveTaskListProps): ReactElement {
	const workspaceState = useRuntimeWorkspaceState();
	const active = useMemo(
		() => selectActiveTasks(workspaceState?.board, workspaceState?.sessions),
		[workspaceState?.board, workspaceState?.sessions],
	);
	const backlog = useMemo(
		() => selectBacklogTasks(workspaceState?.board, workspaceState?.sessions),
		[workspaceState?.board, workspaceState?.sessions],
	);
	const total = active.length + backlog.length;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-2 px-1 pb-3">
				<h2 className="text-sm font-semibold text-text-primary">Tasks</h2>
				{total > 0 ? (
					<span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">
						{total}
					</span>
				) : null}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
				{total === 0 ? (
					<TaskTabEmptyState />
				) : (
					<div className="flex flex-col gap-4">
						<TaskTabSection title="Active" entries={active} agents={agents} onOpenTask={onOpenTask} />
						<TaskTabSection
							title="Backlog"
							entries={backlog}
							agents={agents}
							onOpenTask={onOpenTask}
							muted
						/>
					</div>
				)}
			</div>
		</div>
	);
}

function TaskTabSection({
	title,
	entries,
	agents,
	onOpenTask,
	muted = false,
}: {
	title: string;
	entries: TaskTabEntry[];
	agents: RuntimeAgentDefinition[];
	onOpenTask: (taskId: string) => void;
	/** Backlog tasks are queued, not running — render them slightly de-emphasized. */
	muted?: boolean;
}): ReactElement | null {
	if (entries.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col">
			<div className="flex items-center gap-2 px-1 pb-1.5">
				<h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{title}</h3>
				<span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
					{entries.length}
				</span>
			</div>
			<ul className="flex flex-col gap-1.5">
				{entries.map((entry) => (
					<TaskTabRow key={entry.taskId} entry={entry} agents={agents} onOpenTask={onOpenTask} muted={muted} />
				))}
			</ul>
		</section>
	);
}

function TaskTabEmptyState(): ReactElement {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
			<span className="flex size-10 items-center justify-center rounded-full bg-surface-2 text-text-tertiary">
				<ListChecks size={20} aria-hidden="true" />
			</span>
			<p className="m-0 text-sm font-medium text-text-secondary">No tasks yet</p>
			<p className="m-0 max-w-[260px] text-[12px] leading-snug text-text-tertiary">
				Tasks queued in the backlog and those running or awaiting review show up here.
			</p>
		</div>
	);
}

const COLUMN_LABEL: Record<TaskTabEntry["columnId"], string> = {
	in_progress: "In progress",
	review: "Review",
	backlog: "Backlog",
};

function TaskTabRow({
	entry,
	agents,
	onOpenTask,
	muted,
}: {
	entry: TaskTabEntry;
	agents: RuntimeAgentDefinition[];
	onOpenTask: (taskId: string) => void;
	muted: boolean;
}): ReactElement {
	const status = useMemo(() => deriveHomeSessionCardStatus(entry.summary), [entry.summary]);
	const liveActivity = useMemo(() => getCardSessionActivity(entry.summary), [entry.summary]);
	const lastActivityAt = entry.summary?.lastOutputAt ?? entry.summary?.updatedAt ?? null;
	const timeAgo = formatHomeSessionCardTimeAgo(lastActivityAt, Date.now());

	return (
		<li>
			<button
				type="button"
				onClick={() => onOpenTask(entry.taskId)}
				title={`Open ${entry.title}`}
				className={`group flex w-full cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors hover:border-border-bright hover:bg-surface-3 focus:outline-none focus-visible:border-border-focus ${
					muted ? "border-border/60 bg-surface-2/60" : "border-border bg-surface-2"
				}`}
			>
				<span
					className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
					role="img"
					aria-label={status.label}
					title={status.label}
				>
					<HomeSessionCardStatusMarker status={status} />
				</span>

				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="min-w-0 truncate text-[13px] font-medium text-text-primary">{entry.title}</span>
					{liveActivity ? (
						<span className="flex items-start gap-1.5" role="status" aria-label="Agent activity">
							<span
								className="mt-[3px] inline-block size-1.5 shrink-0 rounded-full"
								style={{ backgroundColor: liveActivity.dotColor }}
							/>
							<span className="m-0 min-w-0 flex-1 truncate font-mono text-[12px] text-text-secondary">
								{liveActivity.text}
							</span>
						</span>
					) : (
						<span className="text-[11px] text-text-tertiary">{COLUMN_LABEL[entry.columnId]}</span>
					)}
				</span>

				<span className="flex shrink-0 items-center gap-2 pt-0.5">
					{entry.summary?.agentId ? (
						<ThreadAgentBadge agents={agents} agentId={entry.summary.agentId} />
					) : null}
					{timeAgo ? <span className="text-[11px] text-text-tertiary">{timeAgo}</span> : null}
				</span>
			</button>
		</li>
	);
}
