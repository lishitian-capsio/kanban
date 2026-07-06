// Directional dependency pills for one task row in the "Session tasks" dialog.
//
// The dependency model is shallow (one-way, backlog↔non-backlog), so a task's
// relationships are fully conveyed by two labelled, arrowed pill groups:
//   "等待 ▸ {title}"  — this task is waiting on {title} (an incoming dependency)
//   "阻塞 ◂ {title}"  — this task is blocking {title} (an outgoing dependency)
// Each pill carries an unlink (×) that removes just that edge. Pure presentation:
// the edges are derived by `use-thread-task-graph`, the removal is delegated.

import { X } from "lucide-react";

import { columnDotColor } from "@/components/home-agent/thread-task-status";
import type { LinkedTaskRef, ThreadTaskLinks } from "@/components/home-agent/use-thread-task-graph";
import { cn } from "@/components/ui/cn";

interface SessionTaskDependencyBadgesProps {
	links: ThreadTaskLinks;
	onDeleteDependency: (dependencyId: string) => void;
}

function DependencyPill({
	prefix,
	arrow,
	link: linkRef,
	onDeleteDependency,
}: {
	prefix: string;
	arrow: string;
	link: LinkedTaskRef;
	onDeleteDependency: (dependencyId: string) => void;
}): React.ReactElement {
	return (
		<span
			className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-1 py-0.5 pl-1.5 pr-1 text-[11px] text-text-secondary"
			title={`${prefix} ${linkRef.title}`}
		>
			<span
				aria-hidden
				className="block h-1.5 w-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: columnDotColor(linkRef.columnId) }}
			/>
			<span className="shrink-0 text-text-tertiary">
				{prefix} {arrow}
			</span>
			<span className="truncate">{linkRef.title}</span>
			<button
				type="button"
				onClick={() => onDeleteDependency(linkRef.dependencyId)}
				aria-label={`Unlink ${linkRef.title}`}
				title="Remove dependency"
				className="flex shrink-0 cursor-pointer items-center rounded-sm p-0.5 text-text-tertiary hover:bg-surface-3 hover:text-status-red"
			>
				<X size={11} />
			</button>
		</span>
	);
}

export function SessionTaskDependencyBadges({
	links,
	onDeleteDependency,
}: SessionTaskDependencyBadgesProps): React.ReactElement | null {
	if (links.waitingOn.length === 0 && links.blocking.length === 0) {
		return null;
	}
	return (
		<div className={cn("flex flex-wrap items-center gap-1")}>
			{links.waitingOn.map((ref) => (
				<DependencyPill
					key={`waiting-${ref.dependencyId}`}
					prefix="等待"
					arrow="▸"
					link={ref}
					onDeleteDependency={onDeleteDependency}
				/>
			))}
			{links.blocking.map((ref) => (
				<DependencyPill
					key={`blocking-${ref.dependencyId}`}
					prefix="阻塞"
					arrow="◂"
					link={ref}
					onDeleteDependency={onDeleteDependency}
				/>
			))}
		</div>
	);
}
