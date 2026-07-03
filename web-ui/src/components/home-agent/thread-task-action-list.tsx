// The status-aware action set for one thread task, shared by the chip's kebab menu
// and the overflow dialog's inline buttons so both surfaces show identical, correctly
// gated actions. Gating lives here (start only for backlog, "Move to Done" hidden for
// already-done tasks); the two renderers only differ in presentation.

import { CircleCheck, PanelRight, Play, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import type { HomeThreadTask, HomeThreadTaskActions } from "@/components/home-agent/thread-tasks";
import { canMoveToDone, isStartable } from "@/components/home-agent/thread-task-status";

export interface ThreadTaskAction {
	key: "start" | "done" | "delete" | "open";
	label: string;
	icon: ReactNode;
	danger?: boolean;
	run: () => void;
}

const ICON_SIZE = 13;

export function buildThreadTaskActions(task: HomeThreadTask, actions: HomeThreadTaskActions): ThreadTaskAction[] {
	const list: ThreadTaskAction[] = [];
	if (isStartable(task.columnId)) {
		list.push({
			key: "start",
			label: "Start",
			icon: <Play size={ICON_SIZE} />,
			run: () => actions.onStartTask(task.id),
		});
	}
	if (canMoveToDone(task.columnId)) {
		list.push({
			key: "done",
			label: "Move to Done",
			icon: <CircleCheck size={ICON_SIZE} />,
			run: () => actions.onMoveTaskToDone(task.id),
		});
	}
	list.push({
		key: "open",
		label: "Open details",
		icon: <PanelRight size={ICON_SIZE} />,
		run: () => actions.onOpenTask(task.id),
	});
	list.push({
		key: "delete",
		label: "Delete",
		icon: <Trash2 size={ICON_SIZE} />,
		danger: true,
		run: () => actions.onDeleteTask(task.id),
	});
	return list;
}
