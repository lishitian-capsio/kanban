import { Draggable } from "@hello-pangea/dnd";
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { buildTaskWorktreeDisplayPath } from "@runtime-task-worktree-path";
import {
	AlertCircle,
	AlertTriangle,
	Bot,
	GitBranch,
	MessageSquare,
	Pencil,
	Play,
	RotateCcw,
	Trash2,
	User,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { showAppToast } from "@/components/app-toaster";
import {
	formatKanbanReasoningEffortLabel,
	formatKanbanSelectedModelButtonText,
	resolveKanbanModelDisplayName,
} from "@/components/detail-panels/kanban-model-picker-options";
import { SessionMetaBadges } from "@/components/session-meta-badges";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { BoardCard as BoardCardModel, BoardColumnId } from "@/types";
import { getTaskAutoReviewCancelButtonLabel } from "@/types";
import { formatPathForDisplay } from "@/utils/path-display";
import { useCopyToClipboard, useMeasure } from "@/utils/react-use";
import {
	type CardSessionActivity,
	getCardSessionActivity,
	isCardCreditLimitError,
	SESSION_ACTIVITY_COLOR,
} from "@/utils/session-activity";
import { formatTaskIdChipLabel } from "@/utils/task-id";
import { getTaskOwnerLabel, getTaskOwnerTooltip } from "@/utils/task-owner";
import {
	clampTextWithInlineSuffix,
	getTaskPromptDescription,
	normalizePromptForDisplay,
	truncateTaskPromptLabel,
} from "@/utils/task-prompt";
import { DEFAULT_TEXT_MEASURE_FONT, measureTextWidth, readElementFontShorthand } from "@/utils/text-measure";

const DESCRIPTION_COLLAPSE_LINES = 3;
const DESCRIPTION_EXPANDED_MAX_LINES = 10;
const DESCRIPTION_EXPAND_LABEL = "See more";
const DESCRIPTION_COLLAPSE_LABEL = "Less";
const DESCRIPTION_COLLAPSE_SUFFIX = `… ${DESCRIPTION_EXPAND_LABEL}`;
const DESCRIPTION_EXPANDED_SUFFIX = `… ${DESCRIPTION_COLLAPSE_LABEL}`;

function reconstructTaskWorktreeDisplayPath(taskId: string, workspacePath: string | null | undefined): string | null {
	if (!workspacePath) {
		return null;
	}
	try {
		return buildTaskWorktreeDisplayPath(taskId, workspacePath);
	} catch {
		return null;
	}
}

function BoardCardComponent({
	card,
	index,
	columnId,
	suppressCulling = false,
	sessionSummary,
	selected = false,
	onActivate,
	onStart,
	onMoveToTrash,
	onRestoreFromTrash,
	onSaveTitle,
	onCommit,
	onOpenPr,
	onCancelAutomaticAction,
	isCommitLoading = false,
	isOpenPrLoading = false,
	isMoveToTrashLoading = false,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	isDependencySource = false,
	isDependencyTarget = false,
	isDependencyLinking = false,
	dragDisabled = false,
	workspacePath,
	defaultKanbanModelId = null,
}: {
	card: BoardCardModel;
	index: number;
	columnId: BoardColumnId;
	suppressCulling?: boolean;
	sessionSummary?: RuntimeTaskSessionSummary;
	selected?: boolean;
	onActivate?: (card: BoardCardModel) => void;
	onStart?: (taskId: string) => void;
	onMoveToTrash?: (taskId: string) => void;
	onRestoreFromTrash?: (taskId: string) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onCommit?: (taskId: string) => void;
	onOpenPr?: (taskId: string) => void;
	onCancelAutomaticAction?: (taskId: string) => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	isMoveToTrashLoading?: boolean;
	onDependencyPointerDown?: (taskId: string, event: MouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	isDependencySource?: boolean;
	isDependencyTarget?: boolean;
	isDependencyLinking?: boolean;
	dragDisabled?: boolean;
	workspacePath?: string | null;
	defaultKanbanModelId?: string | null;
}): React.ReactElement {
	const [isHovered, setIsHovered] = useState(false);
	const [, copyToClipboard] = useCopyToClipboard();
	const taskIdChipLabel = useMemo(() => formatTaskIdChipLabel(card.id), [card.id]);
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [draftTitle, setDraftTitle] = useState(card.title);
	const titleInputRef = useRef<HTMLInputElement | null>(null);
	const titleEditCancelledRef = useRef(false);
	const [descriptionContainerRef, descriptionRect] = useMeasure<HTMLDivElement>();
	const descriptionRef = useRef<HTMLParagraphElement | null>(null);
	const [descriptionWidthFallback, setDescriptionWidthFallback] = useState(0);
	const [descriptionFont, setDescriptionFont] = useState(DEFAULT_TEXT_MEASURE_FONT);
	const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(card.id);
	const isTrashCard = columnId === "trash";
	const isCardInteractive = !isTrashCard;
	const descriptionWidth = descriptionRect.width > 0 ? descriptionRect.width : descriptionWidthFallback;
	const rawSessionActivity = useMemo(() => getCardSessionActivity(sessionSummary), [sessionSummary]);
	const lastSessionActivityRef = useRef<CardSessionActivity | null>(null);
	const lastSessionActivityCardIdRef = useRef<string | null>(null);
	if (lastSessionActivityCardIdRef.current !== card.id) {
		lastSessionActivityCardIdRef.current = card.id;
		lastSessionActivityRef.current = null;
	}
	if (rawSessionActivity) {
		lastSessionActivityRef.current = rawSessionActivity;
	}
	const sessionActivity = rawSessionActivity ?? lastSessionActivityRef.current;
	const displayTitle = useMemo(
		() => normalizePromptForDisplay(card.title) || truncateTaskPromptLabel(card.prompt),
		[card.prompt, card.title],
	);
	const displayDescription = useMemo(
		() => getTaskPromptDescription(card.prompt, displayTitle),
		[card.prompt, displayTitle],
	);

	useLayoutEffect(() => {
		if (descriptionRect.width > 0 || !displayDescription) {
			return;
		}
		const nextWidth = descriptionRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
		if (nextWidth > 0 && nextWidth !== descriptionWidthFallback) {
			setDescriptionWidthFallback(nextWidth);
		}
	}, [descriptionRect.width, descriptionWidthFallback, displayDescription]);

	useLayoutEffect(() => {
		setDescriptionFont(readElementFontShorthand(descriptionRef.current, DEFAULT_TEXT_MEASURE_FONT));
	}, [descriptionWidth, displayDescription]);

	useEffect(() => {
		setIsDescriptionExpanded(false);
	}, [card.id, displayDescription]);

	useEffect(() => {
		setDraftTitle(card.title);
		setIsEditingTitle(false);
	}, [card.id, card.title]);

	useEffect(() => {
		if (!isEditingTitle) {
			return;
		}
		window.requestAnimationFrame(() => {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
		});
	}, [isEditingTitle]);

	const stopEvent = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const handleCopyTaskId = (event: MouseEvent<HTMLElement>) => {
		stopEvent(event);
		copyToClipboard(card.id);
		showAppToast({ intent: "success", message: "已复制任务 ID", timeout: 2000 }, `copy-task-id:${card.id}`);
	};

	const submitTitle = () => {
		if (titleEditCancelledRef.current) {
			titleEditCancelledRef.current = false;
			return;
		}
		setIsEditingTitle(false);
		if (!onSaveTitle) {
			return;
		}
		const trimmed = draftTitle.trim();
		if (trimmed === card.title) {
			return;
		}
		onSaveTitle(card.id, trimmed);
	};

	const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			titleInputRef.current?.blur();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			titleEditCancelledRef.current = true;
			setDraftTitle(card.title);
			setIsEditingTitle(false);
			titleInputRef.current?.blur();
		}
	};

	const isDescriptionMeasured = descriptionRect.width > 0;

	const descriptionDisplay = useMemo(() => {
		if (!displayDescription) {
			return {
				collapsed: { text: "", isTruncated: false },
				expanded: { text: "", isTruncated: false },
			};
		}
		if (descriptionWidth <= 0) {
			return {
				collapsed: { text: displayDescription, isTruncated: false },
				expanded: { text: displayDescription, isTruncated: false },
			};
		}
		const measure = (value: string) => measureTextWidth(value, descriptionFont);
		return {
			collapsed: clampTextWithInlineSuffix(displayDescription, {
				maxWidthPx: descriptionWidth,
				maxLines: DESCRIPTION_COLLAPSE_LINES,
				suffix: DESCRIPTION_COLLAPSE_SUFFIX,
				measureText: measure,
			}),
			expanded: clampTextWithInlineSuffix(displayDescription, {
				maxWidthPx: descriptionWidth,
				maxLines: DESCRIPTION_EXPANDED_MAX_LINES,
				suffix: DESCRIPTION_EXPANDED_SUFFIX,
				measureText: measure,
			}),
		};
	}, [descriptionFont, descriptionWidth, displayDescription]);

	const isCreditLimit = isCardCreditLimitError(sessionSummary);
	const statusMarker = useMemo(() => {
		if (isCreditLimit) {
			return <AlertTriangle size={12} className="text-status-orange" />;
		}
		if (columnId === "in_progress") {
			if (sessionSummary?.state === "failed") {
				return <AlertCircle size={12} className="text-status-red" />;
			}
			return <Spinner size={12} />;
		}
		return null;
	}, [isCreditLimit, columnId, sessionSummary?.state]);
	const showWorkspaceStatus = columnId === "in_progress" || columnId === "review" || isTrashCard;
	const reviewWorkspacePath = reviewWorkspaceSnapshot
		? formatPathForDisplay(reviewWorkspaceSnapshot.path)
		: isTrashCard
			? reconstructTaskWorktreeDisplayPath(card.id, workspacePath)
			: null;
	const reviewRefLabel = reviewWorkspaceSnapshot?.branch ?? reviewWorkspaceSnapshot?.headCommit?.slice(0, 8) ?? "HEAD";
	const reviewChangeSummary = reviewWorkspaceSnapshot
		? reviewWorkspaceSnapshot.changedFiles == null
			? null
			: {
					filesLabel: `${reviewWorkspaceSnapshot.changedFiles} ${reviewWorkspaceSnapshot.changedFiles === 1 ? "file" : "files"}`,
					additions: reviewWorkspaceSnapshot.additions ?? 0,
					deletions: reviewWorkspaceSnapshot.deletions ?? 0,
				}
		: null;
	// A recorded agent-native session id means restoring can re-attach to the exact prior
	// conversation (e.g. `claude --resume <id>`) rather than starting a fresh session, so we
	// surface a "Continue session" affordance instead of the generic restore label.
	const canContinueAgentSession = isTrashCard && !!sessionSummary?.agentSessionId;
	const showReviewGitActions = columnId === "review" && (reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0;
	const isAnyGitActionLoading = isCommitLoading || isOpenPrLoading;
	const cancelAutomaticActionLabel =
		!isTrashCard && card.autoReviewEnabled ? getTaskAutoReviewCancelButtonLabel(card.autoReviewMode) : null;
	const agentOverrideLabel = useMemo(
		() => (card.agentId ? (getRuntimeAgentCatalogEntry(card.agentId)?.label ?? card.agentId) : null),
		[card.agentId],
	);
	const ownerLabel = useMemo(() => getTaskOwnerLabel(card.owner), [card.owner]);
	const ownerTooltip = useMemo(() => getTaskOwnerTooltip(card.owner), [card.owner]);
	const modelOverrideLabel = useMemo(() => {
		if (card.agentSettings === undefined) {
			return null;
		}
		const explicitReasoningLabel = card.agentSettings.reasoningEffort
			? formatKanbanReasoningEffortLabel(card.agentSettings.reasoningEffort)
			: !card.agentSettings.providerId && !card.agentSettings.modelId
				? "Default"
				: null;
		if (card.agentSettings.providerId && !card.agentSettings.modelId) {
			const providerLabel = `Provider: ${card.agentSettings.providerId}`;
			return explicitReasoningLabel ? `${providerLabel} (${explicitReasoningLabel})` : providerLabel;
		}
		const effectiveModelId = card.agentSettings.modelId ?? defaultKanbanModelId;
		if (!effectiveModelId) {
			return explicitReasoningLabel ? `Default model (${explicitReasoningLabel})` : null;
		}
		const modelName = resolveKanbanModelDisplayName(effectiveModelId);
		if (explicitReasoningLabel) {
			return `${modelName} (${explicitReasoningLabel})`;
		}
		const inheritedReasoningEffort = "";
		return formatKanbanSelectedModelButtonText({
			modelName,
			reasoningEffort: inheritedReasoningEffort,
			showReasoningEffort: Boolean(inheritedReasoningEffort),
		});
	}, [card.agentSettings, defaultKanbanModelId]);
	const taskAgentSettingsLabel = useMemo(() => {
		const parts = [agentOverrideLabel, modelOverrideLabel].filter((value): value is string => Boolean(value));
		return parts.length > 0 ? parts.join(" · ") : null;
	}, [agentOverrideLabel, modelOverrideLabel]);

	const activeDescriptionDisplay = isDescriptionExpanded ? descriptionDisplay.expanded : descriptionDisplay.collapsed;

	return (
		<Draggable draggableId={card.id} index={index} isDragDisabled={dragDisabled}>
			{(provided, snapshot) => {
				const isDragging = snapshot.isDragging;
				const draggableContent = (
					<div
						ref={provided.innerRef}
						{...provided.draggableProps}
						{...provided.dragHandleProps}
						className="kb-board-card-shell"
						data-task-id={card.id}
						data-column-id={columnId}
						data-selected={selected}
						onMouseDownCapture={(event) => {
							if (!isCardInteractive) {
								return;
							}
							if (isDependencyLinking) {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							if (!event.metaKey && !event.ctrlKey) {
								return;
							}
							const target = event.target as HTMLElement | null;
							if (target?.closest("button, a, input, textarea, [contenteditable='true']")) {
								return;
							}
							event.preventDefault();
							event.stopPropagation();
							onDependencyPointerDown?.(card.id, event);
						}}
						onClick={(event) => {
							if (!isCardInteractive) {
								return;
							}
							if (isDependencyLinking) {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							if (event.metaKey || event.ctrlKey) {
								return;
							}
							const target = event.target as HTMLElement | null;
							if (target?.closest("button, a, input, textarea, [contenteditable='true']")) {
								return;
							}
							if (!snapshot.isDragging) {
								onActivate?.(card);
							}
						}}
						style={{
							...provided.draggableProps.style,
							marginBottom: 6,
							cursor: "grab",
						}}
						onMouseEnter={() => {
							setIsHovered(true);
							onDependencyPointerEnter?.(card.id);
						}}
						onMouseMove={() => {
							if (!isDependencyLinking) {
								return;
							}
							onDependencyPointerEnter?.(card.id);
						}}
						onMouseLeave={() => setIsHovered(false)}
					>
						<div
							className={cn(
								// `kb-board-card-body` opts each card into off-screen render culling
								// (content-visibility) so large columns don't pay layout/paint for cards
								// the user can't see. Kept off the draggable shell so rbd still measures the
								// card and the drag drop-shadow isn't clipped by paint containment.
								"kb-board-card-body rounded-md border border-border-bright bg-surface-2 p-2.5",
								isCardInteractive && "cursor-pointer hover:bg-surface-3 hover:border-border-bright",
								isDragging && "shadow-lg",
								isHovered && isCardInteractive && "bg-surface-3 border-border-bright",
								isDependencySource && "kb-board-card-dependency-source",
								isDependencyTarget && "kb-board-card-dependency-target",
							)}
							// A card that just changed column is a freshly-mounted element with no
							// remembered intrinsic size, so `content-visibility: auto` would skip
							// painting it for one frame (a visible flicker). Render it eagerly for that
							// first paint; culling re-enables on the next render once it has painted.
							style={suppressCulling ? { contentVisibility: "visible" } : undefined}
						>
							<div className="flex items-center gap-2" style={{ minHeight: 24 }}>
								{statusMarker ? <div className="inline-flex items-center">{statusMarker}</div> : null}
								<button
									type="button"
									title={`Task ID: ${card.id} (click to copy)`}
									aria-label={`Copy task ID ${card.id}`}
									onMouseDown={stopEvent}
									onClick={handleCopyTaskId}
									className="shrink-0 max-w-[10ch] truncate cursor-pointer rounded-sm bg-surface-3 px-1 py-0.5 font-mono text-[10px] leading-none text-text-tertiary hover:bg-surface-4 hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
								>
									{taskIdChipLabel}
								</button>
								<div className="flex-1 min-w-0">
									{isEditingTitle ? (
										<input
											ref={titleInputRef}
											value={draftTitle}
											onChange={(event) => setDraftTitle(event.currentTarget.value)}
											onBlur={submitTitle}
											onKeyDown={handleTitleKeyDown}
											onMouseDown={(event) => {
												event.stopPropagation();
											}}
											className="h-7 w-full rounded-md border border-border-focus bg-surface-2 px-2 text-sm font-medium text-text-primary focus:outline-none"
										/>
									) : onSaveTitle ? (
										<div className="flex items-center gap-1 min-w-0">
											<p
												className={cn(
													"kb-line-clamp-1 m-0 min-w-0 font-medium text-sm",
													isTrashCard && "line-through text-text-tertiary",
												)}
											>
												{displayTitle}
											</p>
											<button
												type="button"
												aria-label="Edit task title"
												onMouseDown={stopEvent}
												onClick={(event) => {
													stopEvent(event);
													setDraftTitle(card.title);
													setIsEditingTitle(true);
												}}
												className={cn(
													"shrink-0 cursor-pointer rounded-sm p-0.5 text-text-tertiary hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
													isHovered ? "opacity-100" : "opacity-0",
												)}
											>
												<Pencil size={12} />
											</button>
										</div>
									) : (
										<p
											className={cn(
												"kb-line-clamp-1 m-0 font-medium text-sm",
												isTrashCard && "line-through text-text-tertiary",
											)}
										>
											{displayTitle}
										</p>
									)}
								</div>
								{columnId === "backlog" ? (
									<Button
										icon={<Play size={14} />}
										variant="ghost"
										size="sm"
										aria-label="Start task"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onStart?.(card.id);
										}}
									/>
								) : columnId === "review" ? (
									<Button
										icon={isMoveToTrashLoading ? <Spinner size={13} /> : <Trash2 size={13} />}
										variant="ghost"
										size="sm"
										disabled={isMoveToTrashLoading}
										aria-label="Move task to done"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onMoveToTrash?.(card.id);
										}}
									/>
								) : columnId === "trash" ? (
									<Tooltip
										side="bottom"
										content={
											canContinueAgentSession ? (
												<>
													Continue session
													<br />
													in original context
												</>
											) : (
												<>
													Restore session
													<br />
													in new worktree
												</>
											)
										}
									>
										<Button
											icon={canContinueAgentSession ? <MessageSquare size={12} /> : <RotateCcw size={12} />}
											variant="ghost"
											size="sm"
											aria-label={
												canContinueAgentSession ? "Continue task session" : "Restore task from done"
											}
											onMouseDown={stopEvent}
											onClick={(event) => {
												stopEvent(event);
												onRestoreFromTrash?.(card.id);
											}}
										/>
									</Tooltip>
								) : null}
							</div>
							{displayDescription ? (
								<div ref={descriptionContainerRef}>
									<p
										ref={descriptionRef}
										className={cn(
											"text-sm leading-[1.4]",
											isTrashCard ? "text-text-tertiary" : "text-text-secondary",
											!isDescriptionMeasured && !isDescriptionExpanded && "line-clamp-3",
										)}
										style={{
											margin: "2px 0 0",
										}}
									>
										{activeDescriptionDisplay.isTruncated
											? activeDescriptionDisplay.text
											: displayDescription}
										{activeDescriptionDisplay.isTruncated ? (
											<>
												{"… "}
												<button
													type="button"
													className="inline cursor-pointer rounded-sm text-text-tertiary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [font:inherit]"
													aria-expanded={isDescriptionExpanded}
													aria-label={
														isDescriptionExpanded
															? "Collapse task description"
															: "Expand task description"
													}
													onMouseDown={stopEvent}
													onClick={(event) => {
														stopEvent(event);
														setIsDescriptionExpanded(!isDescriptionExpanded);
													}}
												>
													{isDescriptionExpanded ? DESCRIPTION_COLLAPSE_LABEL : DESCRIPTION_EXPAND_LABEL}
												</button>
											</>
										) : isDescriptionExpanded && descriptionDisplay.collapsed.isTruncated ? (
											<>
												{" "}
												<button
													type="button"
													className="inline cursor-pointer rounded-sm text-text-tertiary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [font:inherit]"
													aria-expanded={isDescriptionExpanded}
													aria-label="Collapse task description"
													onMouseDown={stopEvent}
													onClick={(event) => {
														stopEvent(event);
														setIsDescriptionExpanded(false);
													}}
												>
													{DESCRIPTION_COLLAPSE_LABEL}
												</button>
											</>
										) : null}
									</p>
								</div>
							) : null}
							{taskAgentSettingsLabel || ownerLabel ? (
								<div className="mt-1 flex flex-wrap items-center gap-1">
									{taskAgentSettingsLabel ? (
										<span
											className={cn(
												"inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
												isTrashCard
													? "border-border text-text-tertiary bg-surface-1"
													: "border-status-blue/30 bg-status-blue/10 text-status-blue",
											)}
										>
											<Bot size={12} className="shrink-0" />
											<span className="truncate">{taskAgentSettingsLabel}</span>
										</span>
									) : null}
									{ownerLabel ? (
										<span
											title={`Owner: ${ownerTooltip}`}
											className={cn(
												"inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
												isTrashCard
													? "border-border text-text-tertiary bg-surface-1"
													: "border-border-bright bg-surface-1 text-text-secondary",
											)}
										>
											<User size={12} className="shrink-0" />
											<span className="truncate">{ownerLabel}</span>
										</span>
									) : null}
								</div>
							) : null}
							{/* Live session provider/model + cumulative token usage. Renders
							    nothing until a session has run, so backlog cards are unaffected. */}
							<SessionMetaBadges summary={sessionSummary} muted={isTrashCard} className="mt-1" />
							{sessionActivity ? (
								<div
									className="flex gap-1.5 items-start mt-[6px]"
									style={{
										color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : undefined,
									}}
								>
									<span
										className="inline-block shrink-0 rounded-full"
										style={{
											width: 6,
											height: 6,
											backgroundColor: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : sessionActivity.dotColor,
											marginTop: 4,
										}}
									/>
									<div className="min-w-0 flex-1">
										<p className="m-0 font-mono truncate" style={{ fontSize: 12 }}>
											{sessionActivity.text}
										</p>
									</div>
								</div>
							) : null}
							{showWorkspaceStatus && reviewWorkspacePath ? (
								<p
									className="font-mono"
									style={{
										margin: "4px 0 0",
										fontSize: 12,
										lineHeight: 1.4,
										whiteSpace: "normal",
										overflowWrap: "anywhere",
										color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : undefined,
									}}
								>
									{isTrashCard ? (
										<span
											style={{
												color: SESSION_ACTIVITY_COLOR.muted,
												textDecoration: "line-through",
											}}
										>
											{reviewWorkspacePath}
										</span>
									) : reviewWorkspaceSnapshot ? (
										<>
											<span style={{ color: SESSION_ACTIVITY_COLOR.secondary }}>{reviewWorkspacePath}</span>
											<GitBranch
												size={10}
												style={{
													display: "inline",
													color: SESSION_ACTIVITY_COLOR.secondary,
													margin: "0px 4px 2px",
													verticalAlign: "middle",
												}}
											/>
											<span style={{ color: SESSION_ACTIVITY_COLOR.secondary }}>{reviewRefLabel}</span>
											{reviewChangeSummary ? (
												<>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}> (</span>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}>
														{reviewChangeSummary.filesLabel}
													</span>
													<span className="text-status-green"> +{reviewChangeSummary.additions}</span>
													<span className="text-status-red"> -{reviewChangeSummary.deletions}</span>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}>)</span>
												</>
											) : null}
										</>
									) : null}
								</p>
							) : null}
							{showReviewGitActions ? (
								<div className="flex gap-1.5 mt-1.5">
									<Button
										variant="primary"
										size="sm"
										icon={isCommitLoading ? <Spinner size={12} /> : undefined}
										disabled={isAnyGitActionLoading}
										style={{ flex: "1 1 0" }}
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onCommit?.(card.id);
										}}
									>
										Commit
									</Button>
									<Button
										variant="primary"
										size="sm"
										icon={isOpenPrLoading ? <Spinner size={12} /> : undefined}
										disabled={isAnyGitActionLoading}
										style={{ flex: "1 1 0" }}
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onOpenPr?.(card.id);
										}}
									>
										Open PR
									</Button>
								</div>
							) : null}
							{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
								<Button
									size="sm"
									fill
									style={{ marginTop: 12 }}
									onMouseDown={stopEvent}
									onClick={(event) => {
										stopEvent(event);
										onCancelAutomaticAction(card.id);
									}}
								>
									{cancelAutomaticActionLabel}
								</Button>
							) : null}
						</div>
					</div>
				);

				if (isDragging && typeof document !== "undefined") {
					return createPortal(draggableContent, document.body);
				}
				return draggableContent;
			}}
		</Draggable>
	);
}

export const BoardCard = memo(BoardCardComponent);
