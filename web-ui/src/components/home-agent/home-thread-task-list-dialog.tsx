// The "Session tasks" dialog behind the task bar's trailing "⋯" button: the
// thread's FULL task list (unbounded by row width), redesigned as a dense,
// column-partitioned manager.
//
// Layout: tasks grouped by board column (Backlog → In progress → Review → Done),
// each row surfacing live status/provider·model/tokens, its dependency
// relationships (directional pills), and inline management — start / move-to-done /
// restore / open / delete, link/unlink, and an auto-review toggle. The bar passes
// only `threadId` + the action set; the dialog reads the thread's cards and their
// dependency graph itself (it's a leaf, only mounted when open). "Open details"
// closes the dialog since it navigates away; the mutating actions keep it open so
// several tasks can be managed in a row.

import { ListChecks } from "lucide-react";
import { useMemo } from "react";

import { SessionTasksColumnGroup } from "@/components/home-agent/session-tasks-column-group";
import type { LinkCandidate } from "@/components/home-agent/session-task-link-control";
import { type SessionTaskDialogActions, useHomeThreadTaskCards } from "@/components/home-agent/thread-tasks";
import { useThreadTaskGraph } from "@/components/home-agent/use-thread-task-graph";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import type { RuntimeBoardCard, RuntimeBoardColumnId } from "@/runtime/types";

interface HomeThreadTaskListDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	threadId: string | null;
	actions: SessionTaskDialogActions;
}

// Canonical top-to-bottom column order for the grouped sections.
const COLUMN_ORDER: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "trash"];

/**
 * Eligible link targets per task. A dependency is one-way and must pair a backlog
 * task with a non-backlog one, so a task's candidates are the thread's tasks on the
 * opposite side of the backlog split (excluding done/trash, itself, and any task it
 * is already linked to). The board handler still re-validates and toasts on reject.
 */
function buildLinkCandidates(
	cardsWithColumn: { card: RuntimeBoardCard; columnId: RuntimeBoardColumnId }[],
	linkedPartnersByTaskId: Map<string, Set<string>>,
): Map<string, LinkCandidate[]> {
	const result = new Map<string, LinkCandidate[]>();
	for (const source of cardsWithColumn) {
		if (source.columnId === "trash") {
			continue;
		}
		const sourceIsBacklog = source.columnId === "backlog";
		const alreadyLinked = linkedPartnersByTaskId.get(source.card.id);
		const candidates: LinkCandidate[] = [];
		for (const target of cardsWithColumn) {
			if (target.card.id === source.card.id || target.columnId === "trash") {
				continue;
			}
			const targetIsBacklog = target.columnId === "backlog";
			if (targetIsBacklog === sourceIsBacklog) {
				continue;
			}
			if (alreadyLinked?.has(target.card.id)) {
				continue;
			}
			candidates.push({ id: target.card.id, title: target.card.title, columnId: target.columnId });
		}
		if (candidates.length > 0) {
			result.set(source.card.id, candidates);
		}
	}
	return result;
}

export function HomeThreadTaskListDialog({
	open,
	onOpenChange,
	threadId,
	actions,
}: HomeThreadTaskListDialogProps): React.ReactElement {
	const threadCards = useHomeThreadTaskCards(threadId);
	const graph = useThreadTaskGraph(threadId);

	// "Open details" navigates to the detail view, so close the dialog with it; the
	// mutating actions keep the dialog open so several tasks can be managed in a row.
	const dialogActions = useMemo<SessionTaskDialogActions>(
		() => ({
			...actions,
			onOpenTask: (taskId) => {
				onOpenChange(false);
				actions.onOpenTask(taskId);
			},
		}),
		[actions, onOpenChange],
	);

	const cardsByColumn = useMemo(() => {
		const map = new Map<RuntimeBoardColumnId, RuntimeBoardCard[]>();
		for (const { card, columnId } of threadCards) {
			const list = map.get(columnId);
			if (list) {
				list.push(card);
			} else {
				map.set(columnId, [card]);
			}
		}
		return map;
	}, [threadCards]);

	const candidatesByTaskId = useMemo(() => {
		const linkedPartnersByTaskId = new Map<string, Set<string>>();
		for (const [taskId, links] of graph) {
			const partners = new Set<string>();
			for (const ref of links.waitingOn) {
				partners.add(ref.taskId);
			}
			for (const ref of links.blocking) {
				partners.add(ref.taskId);
			}
			linkedPartnersByTaskId.set(taskId, partners);
		}
		return buildLinkCandidates(threadCards, linkedPartnersByTaskId);
	}, [threadCards, graph]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-2xl">
			<DialogHeader title="Session tasks" icon={<ListChecks size={16} />} />
			<DialogBody className="max-h-[70vh] overflow-y-auto p-3">
				{threadCards.length === 0 ? (
					<p className="px-2 py-6 text-center text-sm text-text-secondary">
						This session hasn't created any tasks yet.
					</p>
				) : (
					<div className="flex flex-col gap-4">
						{COLUMN_ORDER.map((columnId) => (
							<SessionTasksColumnGroup
								key={columnId}
								columnId={columnId}
								cards={cardsByColumn.get(columnId) ?? []}
								graph={graph}
								candidatesByTaskId={candidatesByTaskId}
								actions={dialogActions}
							/>
						))}
					</div>
				)}
			</DialogBody>
		</Dialog>
	);
}
