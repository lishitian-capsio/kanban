// Placeholder shown while a chat session's initial history is still loading.
// Renders a few subtle, pulsing message rows so the panel doesn't flash an
// empty gap before persisted messages pop in. Purely presentational.
import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";

// Each row alternates sides to echo the user/assistant rhythm of a real
// transcript. Widths vary so the placeholder reads as text, not solid blocks.
const SKELETON_ROWS: ReadonlyArray<{ align: "start" | "end"; lineWidths: ReadonlyArray<string> }> = [
	{ align: "end", lineWidths: ["55%"] },
	{ align: "start", lineWidths: ["90%", "75%", "45%"] },
	{ align: "end", lineWidths: ["40%"] },
	{ align: "start", lineWidths: ["80%", "60%"] },
];

export function KanbanChatHistorySkeleton(): ReactElement {
	return (
		<div
			className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-3 pt-4"
			role="status"
			aria-busy="true"
			aria-label="Loading conversation history"
		>
			{SKELETON_ROWS.map((row, rowIndex) => (
				<div
					key={rowIndex}
					className={cn("flex w-full flex-col gap-2", row.align === "end" ? "items-end" : "items-start")}
				>
					{row.lineWidths.map((width, lineIndex) => (
						<div key={lineIndex} className="h-3 animate-pulse rounded bg-surface-3" style={{ width }} />
					))}
				</div>
			))}
		</div>
	);
}
