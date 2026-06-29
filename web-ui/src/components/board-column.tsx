import { Droppable } from "@hello-pangea/dnd";
import { Play, Plus, Trash2 } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { memo, useCallback } from "react";

import { BoardCard } from "@/components/board-card";
import { BoardColumnFilterControls } from "@/components/board-column-filter-controls";
import { Button } from "@/components/ui/button";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { useColumnView } from "@/hooks/use-column-view";
import { resolveColumnEmptyState } from "@/state/board-column-view";
import { isCardDropDisabled, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type { BoardCard as BoardCardModel, BoardColumnId, BoardColumn as BoardColumnModel } from "@/types";

function BoardColumnComponent({
	column,
	recentlyMovedCardIds,
	onCreateTask,
	onStartTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onSaveTitle,
	onCommitTask,
	onOpenPrTask,
	onCancelAutomaticTaskAction,
	onMoveToTrashTask,
	onRestoreFromTrashTask,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
	onCardClick,
	activeDragTaskId,
	activeDragSourceColumnId,
	programmaticCardMoveInFlight,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	dependencySourceTaskId,
	dependencyTargetTaskId,
	isDependencyLinking,
	workspacePath,
	defaultKanbanModelId,
}: {
	column: BoardColumnModel;
	recentlyMovedCardIds: ReadonlySet<string>;
	onCreateTask?: () => void;
	onStartTask?: (taskId: string) => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	onCardClick?: (card: BoardCardModel) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardColumnId | null;
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
	onDependencyPointerDown?: (taskId: string, event: ReactMouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	dependencySourceTaskId?: string | null;
	dependencyTargetTaskId?: string | null;
	isDependencyLinking?: boolean;
	workspacePath?: string | null;
	defaultKanbanModelId?: string | null;
}): React.ReactElement {
	// A single stable handler shared by every card in this column. Passing a fresh
	// `() => …` closure per card (in the render loop below) would defeat React.memo
	// on BoardCard, since the onActivate prop identity would change on every render.
	const handleCardActivate = useCallback(
		(card: BoardCardModel) => {
			if (column.id === "backlog") {
				onEditTask?.(card);
				return;
			}
			onCardClick?.(card);
		},
		[column.id, onEditTask, onCardClick],
	);

	const columnView = useColumnView(column.cards);
	const { displayedCards, isActive: isViewActive } = columnView;

	const canCreate = column.id === "backlog" && onCreateTask;
	const canStartAllTasks = column.id === "backlog" && onStartAllTasks;
	const canClearTrash = column.id === "trash" && onClearTrash;
	const cardDropType = "CARD";
	// An active per-column view reorders/hides cards relative to their persisted
	// rank, so dropping into (or dragging within) the column would desync the UI
	// order from disk. Disable drop while a view is active; cards also opt out of
	// dragging via `dragDisabled` below.
	const isDropDisabled =
		isViewActive ||
		isCardDropDisabled(column.id, activeDragSourceColumnId ?? null, {
			activeDragTaskId,
			programmaticCardMoveInFlight,
		});
	const emptyState = resolveColumnEmptyState(column.cards.length, displayedCards.length, isViewActive);
	const createTaskButtonText = (
		<span className="inline-flex items-center gap-1.5">
			<span>Create task</span>
			<span aria-hidden className="text-text-secondary">
				(c)
			</span>
		</span>
	);

	return (
		<section
			data-column-id={column.id}
			className="flex flex-col min-w-0 min-h-0 bg-surface-1 rounded-lg overflow-hidden border border-border"
			style={{
				flex: "1 1 0",
			}}
		>
			<div className="flex flex-col min-h-0" style={{ flex: "1 1 0" }}>
				<div
					className="flex items-center justify-between"
					style={{
						height: 40,
						padding: "0 12px",
					}}
				>
					<div className="flex min-w-0 items-center gap-2">
						<ColumnIndicator columnId={column.id} />
						<span className="font-semibold text-sm truncate">{column.title}</span>
						<span className="text-text-secondary text-xs shrink-0">
							{isViewActive ? `${displayedCards.length}/${column.cards.length}` : column.cards.length}
						</span>
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<BoardColumnFilterControls controls={columnView} columnTitle={column.title} />
						{canStartAllTasks ? (
							<Button
								icon={<Play size={14} />}
								variant="ghost"
								size="sm"
								onClick={onStartAllTasks}
								disabled={column.cards.length === 0}
								aria-label="Start all backlog tasks"
								title={column.cards.length > 0 ? "Start all backlog tasks" : "Backlog is empty"}
							/>
						) : null}
						{canClearTrash ? (
							<Button
								icon={<Trash2 size={14} />}
								variant="ghost"
								size="sm"
								className="text-status-red hover:text-status-red"
								onClick={onClearTrash}
								disabled={column.cards.length === 0}
								aria-label="Clear done"
								title={column.cards.length > 0 ? "Clear done items permanently" : "Done is empty"}
							/>
						) : null}
					</div>
				</div>

				<Droppable droppableId={column.id} type={cardDropType} isDropDisabled={isDropDisabled}>
					{(cardProvided) => (
						<div ref={cardProvided.innerRef} {...cardProvided.droppableProps} className="kb-column-cards">
							{canCreate ? (
								<Button
									icon={<Plus size={14} />}
									aria-label="Create task"
									fill
									onClick={onCreateTask}
									style={{ marginBottom: 6, flexShrink: 0 }}
								>
									{createTaskButtonText}
								</Button>
							) : null}

							{(() => {
								const items: ReactNode[] = [];
								let draggableIndex = 0;
								for (const card of displayedCards) {
									if (column.id === "backlog" && editingTaskId === card.id) {
										items.push(
											<div
												key={card.id}
												data-task-id={card.id}
												data-column-id={column.id}
												style={{ marginBottom: 6 }}
											>
												{inlineTaskEditor}
											</div>,
										);
										continue;
									}
									items.push(
										<BoardCard
											key={card.id}
											card={card}
											index={draggableIndex}
											columnId={column.id}
											suppressCulling={recentlyMovedCardIds.has(card.id)}
											onStart={onStartTask}
											onMoveToTrash={onMoveToTrashTask}
											onRestoreFromTrash={onRestoreFromTrashTask}
											onCommit={onCommitTask}
											onOpenPr={onOpenPrTask}
											onCancelAutomaticAction={onCancelAutomaticTaskAction}
											isCommitLoading={commitTaskLoadingById?.[card.id] ?? false}
											isOpenPrLoading={openPrTaskLoadingById?.[card.id] ?? false}
											isMoveToTrashLoading={moveToTrashLoadingById?.[card.id] ?? false}
											onDependencyPointerDown={onDependencyPointerDown}
											onDependencyPointerEnter={onDependencyPointerEnter}
											isDependencySource={dependencySourceTaskId === card.id}
											isDependencyTarget={dependencyTargetTaskId === card.id}
											isDependencyLinking={isDependencyLinking}
											dragDisabled={isViewActive}
											workspacePath={workspacePath}
											defaultKanbanModelId={defaultKanbanModelId}
											onSaveTitle={onSaveTitle}
											onActivate={handleCardActivate}
										/>,
									);
									draggableIndex += 1;
								}
								return items;
							})()}
							{cardProvided.placeholder}
							{emptyState !== "none" ? (
								<div className="px-1 py-3 text-center text-xs text-text-tertiary">
									{emptyState === "no-matches" ? (
										<div className="flex flex-col items-center gap-1.5">
											<span>No tasks match this column's filters.</span>
											<button
												type="button"
												onClick={columnView.reset}
												className="cursor-pointer text-accent hover:underline"
											>
												Clear filters
											</button>
										</div>
									) : (
										<span>No tasks here yet.</span>
									)}
								</div>
							) : null}
						</div>
					)}
				</Droppable>
			</div>
		</section>
	);
}

// Memoized so a high-frequency App re-render (e.g. a per-task session tick that
// updates App's `sessions` for the auto-column-move effect) does not reconcile
// every column. Props are stable during ticks now that each card's session
// summary is read at the leaf (BoardCard) rather than threaded through here.
export const BoardColumn = memo(BoardColumnComponent);
