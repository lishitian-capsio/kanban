// A compact single-line status-count row for a Home-tab launcher session card:
// how many tasks the card's thread has in progress / awaiting review / done.
//
// Quiet by design: the whole row is hidden when the thread has no active tasks,
// and within the row only the non-zero buckets render — no row of noisy zeros.
// Colors follow the design tokens (in progress → status-blue, review →
// status-orange, done → status-green).

import type { HomeThreadTaskCounts } from "@/components/home-agent/thread-task-counts";
import { cn } from "@/components/ui/cn";

interface HomeSessionTaskCountRowProps {
	counts: HomeThreadTaskCounts;
}

interface CountSegment {
	key: keyof Omit<HomeThreadTaskCounts, "total">;
	count: number;
	label: string;
	dotClass: string;
	countClass: string;
}

export function HomeSessionTaskCountRow({ counts }: HomeSessionTaskCountRowProps): React.ReactElement | null {
	// No active tasks → render nothing rather than a muted placeholder, keeping the
	// card uncluttered for the common "just chatting" thread.
	if (counts.total === 0) {
		return null;
	}

	const allSegments: CountSegment[] = [
		{
			key: "inProgress",
			count: counts.inProgress,
			label: "进行",
			dotClass: "bg-status-blue",
			countClass: "text-status-blue",
		},
		{
			key: "review",
			count: counts.review,
			label: "待审",
			dotClass: "bg-status-orange",
			countClass: "text-status-orange",
		},
		{ key: "done", count: counts.done, label: "完成", dotClass: "bg-status-green", countClass: "text-status-green" },
	];
	const segments = allSegments.filter((segment) => segment.count > 0);

	return (
		<div
			className="flex shrink-0 items-center gap-2.5 overflow-hidden text-[11px] leading-none"
			role="group"
			aria-label={`发起任务：进行 ${counts.inProgress}，待审 ${counts.review}，完成 ${counts.done}`}
			title={`进行 ${counts.inProgress} · 待审 ${counts.review} · 完成 ${counts.done}`}
		>
			{segments.map((segment) => (
				<span key={segment.key} className="flex shrink-0 items-center gap-1">
					<span className={cn("size-1.5 shrink-0 rounded-full", segment.dotClass)} aria-hidden="true" />
					<span className={cn("font-medium tabular-nums", segment.countClass)}>{segment.count}</span>
					<span className="text-text-tertiary">{segment.label}</span>
				</span>
			))}
		</div>
	);
}
