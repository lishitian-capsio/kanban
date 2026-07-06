// Persistent, single-line task bar for the active home chat thread.
//
// It shows the thread's tasks as chips (status dot + truncated title + hover kebab),
// with a fixed trailing "⋯" button that opens the full-list dialog. The row NEVER
// wraps or scrolls: a hidden measuring layer sizes every chip, and only the leading
// chips that fit inline are rendered — the rest live in the dialog. This replaces the
// old dismissible "show tips" hint (decision: the thread's real work is more useful
// than static tips).
//
// Runtime-store subscription (`useHomeThreadTasks`) lives in this leaf per the store's
// leaf-subscription rule, so a board change only re-renders the bar.

import { MoreHorizontal } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { HomeThreadTaskChip, MeasureChip } from "@/components/home-agent/home-thread-task-chip";
import { HomeThreadTaskListDialog } from "@/components/home-agent/home-thread-task-list-dialog";
import { computeVisibleChipCount } from "@/components/home-agent/thread-task-bar-overflow";
import { type SessionTaskDialogActions, useHomeThreadTasks } from "@/components/home-agent/thread-tasks";
import { useMeasure } from "@/utils/react-use";

const CHIP_GAP = 4; // matches the flex `gap-1` on the row

interface HomeThreadTaskBarProps {
	threadId: string | null;
	actions: SessionTaskDialogActions;
}

export function HomeThreadTaskBar({ threadId, actions }: HomeThreadTaskBarProps): React.ReactElement | null {
	const tasks = useHomeThreadTasks(threadId);
	const [rowRef, rowRect] = useMeasure<HTMLDivElement>();
	const chipRefs = useRef<(HTMLDivElement | null)[]>([]);
	const overflowButtonRef = useRef<HTMLButtonElement>(null);
	const [visibleCount, setVisibleCount] = useState(tasks.length);
	const [isListOpen, setIsListOpen] = useState(false);

	useLayoutEffect(() => {
		const widths = chipRefs.current.slice(0, tasks.length).map((element) => element?.offsetWidth ?? 0);
		const overflowWidth = overflowButtonRef.current?.offsetWidth ?? 0;
		setVisibleCount(computeVisibleChipCount(widths, rowRect.width, CHIP_GAP, overflowWidth));
	}, [tasks, rowRect.width]);

	if (!threadId) {
		return null;
	}

	if (tasks.length === 0) {
		// Persistent even when empty — the bar occupies the tips slot and hints at what
		// it will hold once the session creates tasks.
		return (
			<div className="flex h-6 shrink-0 items-center text-[11px] text-text-tertiary">
				No tasks from this session yet.
			</div>
		);
	}

	const cappedVisibleCount = Math.min(visibleCount, tasks.length);
	const visibleTasks = tasks.slice(0, cappedVisibleCount);

	return (
		<div className="shrink-0">
			<div ref={rowRef} className="flex w-full min-w-0 items-center gap-1 overflow-hidden">
				{visibleTasks.map((task) => (
					<HomeThreadTaskChip key={task.id} task={task} actions={actions} />
				))}
				<button
					ref={overflowButtonRef}
					type="button"
					onClick={() => setIsListOpen(true)}
					aria-label="Show all session tasks"
					title="Show all session tasks"
					className="flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-md border border-border bg-surface-2 px-1.5 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
				>
					<MoreHorizontal size={14} />
					<span className="text-[11px] tabular-nums">{tasks.length}</span>
				</button>
			</div>

			{/* Hidden measuring layer: every chip at resting width, off-screen and inert,
			    so the overflow math above knows how many chips fit. */}
			<div aria-hidden className="pointer-events-none absolute -left-[9999px] top-0 flex items-center gap-1">
				{tasks.map((task, index) => (
					<div
						key={task.id}
						ref={(element) => {
							chipRefs.current[index] = element;
						}}
					>
						<MeasureChip task={task} />
					</div>
				))}
			</div>

			<HomeThreadTaskListDialog
				open={isListOpen}
				onOpenChange={setIsListOpen}
				threadId={threadId}
				actions={actions}
			/>
		</div>
	);
}
