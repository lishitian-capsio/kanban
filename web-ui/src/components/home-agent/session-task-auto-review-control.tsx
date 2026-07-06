// Compact auto-review control for a task row in the "Session tasks" dialog: a
// small on/off switch plus a commit|PR mode picker (disabled while off). Writes
// go through the caller's `onSetAutoReview`, which reuses the board's `updateTask`
// path, so a change persists exactly like the full edit form.

import * as RadixSwitch from "@radix-ui/react-switch";
import { useId } from "react";

import { NativeSelect } from "@/components/ui/native-select";
import { resolveTaskAutoReviewMode, type TaskAutoReviewMode } from "@/types";

interface SessionTaskAutoReviewControlProps {
	taskId: string;
	title: string;
	enabled: boolean;
	mode: TaskAutoReviewMode;
	onSetAutoReview: (taskId: string, enabled: boolean, mode: TaskAutoReviewMode) => void;
}

export function SessionTaskAutoReviewControl({
	taskId,
	title,
	enabled,
	mode,
	onSetAutoReview,
}: SessionTaskAutoReviewControlProps): React.ReactElement {
	const labelId = useId();
	const resolvedMode = resolveTaskAutoReviewMode(mode);
	return (
		<div className="flex items-center gap-1.5">
			<span id={labelId} className="text-[11px] text-text-tertiary">
				Auto-review
			</span>
			<RadixSwitch.Root
				checked={enabled}
				onCheckedChange={(next) => onSetAutoReview(taskId, next, resolvedMode)}
				aria-labelledby={labelId}
				aria-label={`Toggle auto-review: ${title}`}
				className="relative h-4 w-7 shrink-0 cursor-pointer rounded-full bg-surface-4 transition-colors data-[state=checked]:bg-accent"
			>
				<RadixSwitch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[14px]" />
			</RadixSwitch.Root>
			<NativeSelect
				size="sm"
				value={resolvedMode}
				disabled={!enabled}
				aria-label={`Auto-review mode: ${title}`}
				onChange={(event) => onSetAutoReview(taskId, enabled, event.target.value as TaskAutoReviewMode)}
			>
				<option value="commit">Commit</option>
				<option value="pr">PR</option>
			</NativeSelect>
		</div>
	);
}
