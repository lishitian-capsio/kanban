// The button cluster for a task row in the "Session tasks" dialog: the shared,
// status-gated Start / Move-to-Done / Open / Delete actions (from
// `buildThreadTaskActions`), plus a Restore action for done/trashed tasks. Only
// lifecycle-legal transitions are offered — column moves route through the same
// safe board handlers the kanban board's drags use.

import { RotateCcw } from "lucide-react";

import { buildThreadTaskActions } from "@/components/home-agent/thread-task-action-list";
import type { HomeThreadTask, SessionTaskDialogActions } from "@/components/home-agent/thread-tasks";
import { Button } from "@/components/ui/button";

interface SessionTaskActionsProps {
	task: HomeThreadTask;
	actions: SessionTaskDialogActions;
}

export function SessionTaskActions({ task, actions }: SessionTaskActionsProps): React.ReactElement {
	const isDone = task.columnId === "trash";
	return (
		<span className="flex shrink-0 items-center gap-1">
			{isDone ? (
				<Button
					variant="ghost"
					size="sm"
					icon={<RotateCcw size={13} />}
					onClick={() => actions.onRestoreTask(task.id)}
					aria-label={`Restore: ${task.title}`}
				>
					Restore
				</Button>
			) : null}
			{buildThreadTaskActions(task, actions).map((action) => (
				<Button
					key={action.key}
					variant={action.danger ? "danger" : "ghost"}
					size="sm"
					icon={action.icon}
					onClick={action.run}
					aria-label={`${action.label}: ${task.title}`}
				>
					{action.label}
				</Button>
			))}
		</span>
	);
}
