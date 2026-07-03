// One task as a compact chip in the thread task bar: a status-coloured dot, the
// truncated title, and a hover-revealed kebab (⋮) opening the status-aware quick
// actions. Clicking the chip body opens the task detail (same as the "Open details"
// action). The kebab is absolutely positioned so it never widens the chip's resting
// footprint — the bar's overflow math measures that resting width.
//
// `CHIP_BOX_CLASS` + `ChipContent` are shared with the bar's hidden measuring layer
// so a measured chip's width matches the rendered chip's resting width exactly.

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreVertical } from "lucide-react";

import { cn } from "@/components/ui/cn";
import { buildThreadTaskActions } from "@/components/home-agent/thread-task-action-list";
import { columnDotColor, columnStatusLabel } from "@/components/home-agent/thread-task-status";
import type { HomeThreadTask, HomeThreadTaskActions } from "@/components/home-agent/thread-tasks";

/** Resting box of a chip (no hover/interaction state) — shared with the measuring layer. */
export const CHIP_BOX_CLASS = "relative flex h-6 shrink-0 items-center rounded-md border border-border bg-surface-2";
const CHIP_CONTENT_CLASS = "flex max-w-[160px] items-center gap-1.5 px-2 py-0.5 text-left";

/** Dot + truncated title — the chip's resting content, identical in chip and measurer. */
export function ChipContent({ task }: { task: HomeThreadTask }): React.ReactElement {
	return (
		<>
			<span
				aria-hidden
				className="block h-1.5 w-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: columnDotColor(task.columnId) }}
			/>
			<span className="min-w-0 truncate text-[11px] text-text-primary">{task.title}</span>
		</>
	);
}

interface HomeThreadTaskChipProps {
	task: HomeThreadTask;
	actions: HomeThreadTaskActions;
}

export function HomeThreadTaskChip({ task, actions }: HomeThreadTaskChipProps): React.ReactElement {
	const menuActions = buildThreadTaskActions(task, actions);
	const statusLabel = columnStatusLabel(task.columnId);
	return (
		<div className={cn(CHIP_BOX_CLASS, "group/chip hover:bg-surface-3")}>
			<button
				type="button"
				onClick={() => actions.onOpenTask(task.id)}
				title={`${task.title} · ${statusLabel}`}
				className={cn(CHIP_CONTENT_CLASS, "cursor-pointer rounded-md outline-none")}
			>
				<ChipContent task={task} />
			</button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						aria-label={`Task actions for ${task.title}`}
						className={cn(
							"absolute right-0 top-0 flex h-full cursor-pointer items-center rounded-r-md px-1 text-text-tertiary outline-none",
							// Hidden at rest so it never covers the title; revealed on hover / when open.
							"bg-surface-3 opacity-0 group-hover/chip:opacity-100 hover:text-text-primary data-[state=open]:opacity-100",
						)}
						onClick={(event) => event.stopPropagation()}
					>
						<MoreVertical size={13} />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						side="bottom"
						align="end"
						sideOffset={4}
						className="z-50 min-w-[160px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
						onCloseAutoFocus={(event) => event.preventDefault()}
					>
						{menuActions.map((action) => (
							<DropdownMenu.Item
								key={action.key}
								className={cn(
									"flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-3",
									action.danger ? "text-status-red" : "text-text-primary",
								)}
								onSelect={action.run}
							>
								<span className="shrink-0">{action.icon}</span>
								{action.label}
							</DropdownMenu.Item>
						))}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</div>
	);
}

/** Non-interactive clone used only for width measurement in the bar's hidden layer. */
export function MeasureChip({ task }: { task: HomeThreadTask }): React.ReactElement {
	return (
		<div className={CHIP_BOX_CLASS}>
			<div className={CHIP_CONTENT_CLASS}>
				<ChipContent task={task} />
			</div>
		</div>
	);
}
