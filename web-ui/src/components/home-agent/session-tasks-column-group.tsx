// One column section in the "Session tasks" dialog: a header (column dot + label +
// count) over the rows for that column. Grouping by column is the dialog's primary
// partition — it separates backlog (dependency sources) from started tasks
// (targets), which makes dependency direction legible, and keeps the layout dense
// without crowding.

import { SessionTaskRow } from "@/components/home-agent/session-task-row";
import type { LinkCandidate } from "@/components/home-agent/session-task-link-control";
import { columnDotColor, columnStatusLabel } from "@/components/home-agent/thread-task-status";
import type { SessionTaskDialogActions } from "@/components/home-agent/thread-tasks";
import { threadTaskLinks, type ThreadTaskLinks } from "@/components/home-agent/use-thread-task-graph";
import type { RuntimeBoardCard, RuntimeBoardColumnId } from "@/runtime/types";

interface SessionTasksColumnGroupProps {
	columnId: RuntimeBoardColumnId;
	cards: RuntimeBoardCard[];
	graph: Map<string, ThreadTaskLinks>;
	candidatesByTaskId: Map<string, LinkCandidate[]>;
	actions: SessionTaskDialogActions;
}

const EMPTY_CANDIDATES: LinkCandidate[] = [];

export function SessionTasksColumnGroup({
	columnId,
	cards,
	graph,
	candidatesByTaskId,
	actions,
}: SessionTasksColumnGroupProps): React.ReactElement | null {
	if (cards.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col gap-1.5">
			<header className="flex items-center gap-2 px-0.5">
				<span
					aria-hidden
					className="block h-2 w-2 shrink-0 rounded-full"
					style={{ backgroundColor: columnDotColor(columnId) }}
				/>
				<span className="text-[12px] font-medium text-text-secondary">{columnStatusLabel(columnId)}</span>
				<span className="text-[11px] tabular-nums text-text-tertiary">{cards.length}</span>
			</header>
			<ul className="m-0 flex list-none flex-col gap-1 p-0">
				{cards.map((card) => (
					<SessionTaskRow
						key={card.id}
						card={card}
						columnId={columnId}
						links={threadTaskLinks(graph, card.id)}
						linkCandidates={candidatesByTaskId.get(card.id) ?? EMPTY_CANDIDATES}
						actions={actions}
					/>
				))}
			</ul>
		</section>
	);
}
