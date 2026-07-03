// The overflow dialog behind the task bar's trailing "⋯" button: the thread's FULL
// task list (unbounded by row width), one row per task with the same status-aware
// actions the chip kebab offers, laid out as roomy inline buttons — the "view all +
// manage" entry point. The list is derived by the parent from live workspace state,
// so rows update as tasks move columns; "Open details" also closes the dialog since
// it navigates away.

import { ListChecks } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { buildThreadTaskActions } from "@/components/home-agent/thread-task-action-list";
import { columnDotColor, columnStatusLabel } from "@/components/home-agent/thread-task-status";
import type { HomeThreadTask, HomeThreadTaskActions } from "@/components/home-agent/thread-tasks";

interface HomeThreadTaskListDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	tasks: HomeThreadTask[];
	actions: HomeThreadTaskActions;
}

export function HomeThreadTaskListDialog({
	open,
	onOpenChange,
	tasks,
	actions,
}: HomeThreadTaskListDialogProps): React.ReactElement {
	// "Open details" navigates to the detail view, so close the dialog with it; the
	// mutating actions keep the dialog open so several tasks can be managed in a row.
	const dialogActions: HomeThreadTaskActions = {
		...actions,
		onOpenTask: (taskId) => {
			onOpenChange(false);
			actions.onOpenTask(taskId);
		},
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-md">
			<DialogHeader title="Session tasks" icon={<ListChecks size={16} />} />
			<DialogBody className="p-2">
				{tasks.length === 0 ? (
					<p className="px-2 py-6 text-center text-sm text-text-secondary">
						This session hasn't created any tasks yet.
					</p>
				) : (
					<ul className="m-0 flex list-none flex-col gap-1 p-0">
						{tasks.map((task) => (
							<li
								key={task.id}
								className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2 py-1.5"
							>
								<span
									aria-hidden
									className="block h-2 w-2 shrink-0 rounded-full"
									style={{ backgroundColor: columnDotColor(task.columnId) }}
								/>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13px] text-text-primary" title={task.title}>
										{task.title}
									</span>
									<span className="block text-[11px] text-text-tertiary">
										{columnStatusLabel(task.columnId)}
									</span>
								</span>
								<span className="flex shrink-0 items-center gap-1">
									{buildThreadTaskActions(task, dialogActions).map((action) => (
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
							</li>
						))}
					</ul>
				)}
			</DialogBody>
		</Dialog>
	);
}
