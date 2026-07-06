// A "Link" affordance for a task row in the "Session tasks" dialog: a small button
// that opens a popover listing candidate tasks this one can depend on. Dependencies
// are one-way and backlog↔non-backlog, so candidates are the thread's tasks on the
// opposite side of the backlog split (computed by the parent). Ordering is handled
// by the board's `addTaskDependency`, which normalises which endpoint is the
// backlog source — so we just pass both ids and let the gate + toast (already in
// `handleCreateDependency`) reject anything invalid.

import * as Popover from "@radix-ui/react-popover";
import { Link2 } from "lucide-react";
import { useState } from "react";

import { columnDotColor } from "@/components/home-agent/thread-task-status";
import type { RuntimeBoardColumnId } from "@/runtime/types";

export interface LinkCandidate {
	id: string;
	title: string;
	columnId: RuntimeBoardColumnId;
}

interface SessionTaskLinkControlProps {
	taskId: string;
	candidates: LinkCandidate[];
	onCreateDependency: (fromTaskId: string, toTaskId: string) => void;
}

export function SessionTaskLinkControl({
	taskId,
	candidates,
	onCreateDependency,
}: SessionTaskLinkControlProps): React.ReactElement | null {
	const [open, setOpen] = useState(false);
	if (candidates.length === 0) {
		return null;
	}
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label="Link a dependency"
					title="Link a dependency"
					className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
				>
					<Link2 size={13} />
					Link
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={4}
					className="z-50 flex max-h-64 w-64 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border-bright bg-surface-1 p-1 shadow-2xl"
				>
					<p className="px-2 py-1 text-[11px] text-text-tertiary">Depend on…</p>
					{candidates.map((candidate) => (
						<button
							key={candidate.id}
							type="button"
							onClick={() => {
								onCreateDependency(taskId, candidate.id);
								setOpen(false);
							}}
							className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-text-primary hover:bg-surface-3"
						>
							<span
								aria-hidden
								className="block h-1.5 w-1.5 shrink-0 rounded-full"
								style={{ backgroundColor: columnDotColor(candidate.columnId) }}
							/>
							<span className="truncate">{candidate.title}</span>
						</button>
					))}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
