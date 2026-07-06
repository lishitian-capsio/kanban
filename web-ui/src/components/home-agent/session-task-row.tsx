// One task row in the "Session tasks" dialog. Three lines, dense but legible:
//   1. live status dot + title + the action button cluster
//   2. provider·model + token chips (<SessionMetaBadges>) + one-line live activity
//   3. dependency pills + link control + auto-review control (non-done tasks)
//
// The live session summary is subscribed HERE (`useTaskSessionSummary`) per the
// runtime store's leaf-subscription rule, so a token tick for this task only
// re-renders this row, not the whole dialog.

import { SessionMetaBadges } from "@/components/session-meta-badges";
import { SessionTaskActions } from "@/components/home-agent/session-task-actions";
import { SessionTaskAutoReviewControl } from "@/components/home-agent/session-task-auto-review-control";
import { SessionTaskDependencyBadges } from "@/components/home-agent/session-task-dependency-badges";
import { SessionTaskLinkControl, type LinkCandidate } from "@/components/home-agent/session-task-link-control";
import { columnDotColor } from "@/components/home-agent/thread-task-status";
import type { HomeThreadTask, SessionTaskDialogActions } from "@/components/home-agent/thread-tasks";
import type { ThreadTaskLinks } from "@/components/home-agent/use-thread-task-graph";
import { useTaskSessionSummary } from "@/runtime/runtime-stream-store";
import type { RuntimeBoardCard, RuntimeBoardColumnId } from "@/runtime/types";
import { resolveTaskAutoReviewMode } from "@/types";
import { getCardSessionActivity } from "@/utils/session-activity";

interface SessionTaskRowProps {
	card: RuntimeBoardCard;
	columnId: RuntimeBoardColumnId;
	links: ThreadTaskLinks;
	linkCandidates: LinkCandidate[];
	actions: SessionTaskDialogActions;
}

export function SessionTaskRow({
	card,
	columnId,
	links,
	linkCandidates,
	actions,
}: SessionTaskRowProps): React.ReactElement {
	const summary = useTaskSessionSummary(card.id);
	const activity = getCardSessionActivity(summary);
	const isDone = columnId === "trash";
	const task: HomeThreadTask = { id: card.id, title: card.title, columnId };
	const dotColor = activity?.dotColor ?? columnDotColor(columnId);

	return (
		<li className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-2">
			<div className="flex items-center gap-2">
				<span
					aria-hidden
					className="block h-2 w-2 shrink-0 rounded-full"
					style={{ backgroundColor: dotColor }}
				/>
				<span className="min-w-0 flex-1 truncate text-[13px] text-text-primary" title={card.title}>
					{card.title}
				</span>
				<SessionTaskActions task={task} actions={actions} />
			</div>

			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-4">
				<SessionMetaBadges summary={summary} muted={isDone} />
				{activity ? (
					<span className="truncate text-[11px] text-text-secondary" title={activity.text}>
						{activity.text}
					</span>
				) : null}
			</div>

			{(links.waitingOn.length > 0 || links.blocking.length > 0 || linkCandidates.length > 0 || !isDone) && (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-4">
					<SessionTaskDependencyBadges links={links} onDeleteDependency={actions.onDeleteDependency} />
					<SessionTaskLinkControl
						taskId={card.id}
						candidates={linkCandidates}
						onCreateDependency={actions.onCreateDependency}
					/>
					{!isDone ? (
						<SessionTaskAutoReviewControl
							taskId={card.id}
							title={card.title}
							enabled={card.autoReviewEnabled ?? false}
							mode={resolveTaskAutoReviewMode(card.autoReviewMode)}
							onSetAutoReview={actions.onSetAutoReview}
						/>
					) : null}
				</div>
			)}
		</li>
	);
}
