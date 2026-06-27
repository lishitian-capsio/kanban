// Layout component for the native Kanban chat panel.
// Rendering lives here, while session state and action wiring come from the
// controller hook so multiple surfaces can share the same behavior.

import React, {
	type ReactElement,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { Virtuoso, type Components as VirtuosoComponents } from "react-virtuoso";

import { KanbanChatComposer } from "@/components/detail-panels/kanban-chat-composer";
import { KanbanChatHistorySkeleton } from "@/components/detail-panels/kanban-chat-history-skeleton";
import { KanbanChatMessageItem } from "@/components/detail-panels/kanban-chat-message-item";
import {
	buildKanbanAgentModelPickerOptions,
	buildKanbanSelectedModelButtonText,
	getKanbanReasoningEnabledModelIds,
} from "@/components/detail-panels/kanban-model-picker-options";
import { KanbanThinkingIndicator } from "@/components/detail-panels/kanban-thinking-indicator";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { useKanbanChatPanelController } from "@/hooks/use-kanban-chat-panel-controller";
import type { KanbanChatActionResult } from "@/hooks/use-kanban-chat-runtime-actions";
import type { KanbanChatMessage } from "@/hooks/use-kanban-chat-session";
import { useRuntimeSettingsKanbanController } from "@/hooks/use-runtime-settings-kanban-controller";
import { appendTranscriptToDraft } from "@/hooks/voice-input-state";
import type {
	RuntimeConfigResponse,
	RuntimeReasoningEffort,
	RuntimeTaskAgentSettings,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { TaskImage } from "@/types";

// Treat the viewport as "at the bottom" within this many pixels, so Virtuoso
// keeps following streamed output even when a freshly grown last message leaves
// a sub-pixel gap.
const BOTTOM_LOCK_THRESHOLD_PX = 24;

// Dynamic trailing content (thinking indicator) and the list's bottom padding
// live in the virtualized footer so they grow/shrink in place and
// `followOutput` keeps them in view while pinned to the bottom.
interface KanbanChatListContext {
	showAgentProgressIndicator: boolean;
}

const KanbanChatListFooter: VirtuosoComponents<KanbanChatMessage, KanbanChatListContext>["Footer"] = ({ context }) => (
	<div className="flex flex-col gap-2 px-2 pt-2 pb-3">
		{context?.showAgentProgressIndicator ? <KanbanThinkingIndicator /> : null}
	</div>
);

const KANBAN_CHAT_LIST_COMPONENTS: VirtuosoComponents<KanbanChatMessage, KanbanChatListContext> = {
	Footer: KanbanChatListFooter,
};

function renderKanbanChatMessageItem(index: number, message: KanbanChatMessage): ReactElement {
	return (
		<div className={cn("px-2", index === 0 ? "pt-3" : "pt-2")}>
			<KanbanChatMessageItem message={message} />
		</div>
	);
}

function computeKanbanChatMessageKey(_index: number, message: KanbanChatMessage): string {
	return message.id;
}

export interface KanbanAgentChatPanelHandle {
	appendToDraft: (text: string) => void;
	sendText: (text: string) => Promise<void>;
}

export interface KanbanAgentChatPanelProps {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	taskColumnId?: string;
	defaultMode?: RuntimeTaskSessionMode;
	composerPlaceholder?: string;
	showComposerModeToggle?: boolean;
	workspaceId?: string | null;
	runtimeConfig?: RuntimeConfigResponse | null;
	// When set, replaces the composer's bare model selector with a richer control
	// (e.g. the home sidebar's session provider switch). This panel stays agnostic
	// about what the slot does — the owner builds and wires it.
	modelControlSlot?: ReactElement | null;
	// Optional content rendered just above the composer (e.g. the home sidebar's clickable
	// next-step suggestion chip). The panel stays agnostic about what it is — the owner builds
	// and wires it; omitted on surfaces that don't use it.
	suggestionSlot?: ReactElement | null;
	taskKanbanSettings?: RuntimeTaskAgentSettings;
	taskHasExplicitKanbanSettings?: boolean;
	onKanbanSettingsSaved?: () => void;
	onTaskKanbanSettingsChanged?: (settings: {
		providerId: string;
		modelId: string;
		reasoningEffort: RuntimeReasoningEffort | "";
	}) => void;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: TaskImage[] },
	) => Promise<KanbanChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<KanbanChatMessage[] | null>;
	incomingMessages?: KanbanChatMessage[] | null;
	incomingMessage?: KanbanChatMessage | null;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	onMoveToTrash?: () => void;
	isMoveToTrashLoading?: boolean;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
}

export const KanbanAgentChatPanel = React.forwardRef<KanbanAgentChatPanelHandle, KanbanAgentChatPanelProps>(
	function KanbanAgentChatPanel(
		{
			taskId,
			summary,
			taskColumnId = "in_progress",
			defaultMode = "act",
			composerPlaceholder = "Ask Kanban to add, edit, start, or link tasks",
			showComposerModeToggle = true,
			workspaceId = null,
			runtimeConfig = null,
			modelControlSlot = null,
			suggestionSlot = null,
			taskKanbanSettings,
			taskHasExplicitKanbanSettings = false,
			onKanbanSettingsSaved,
			onTaskKanbanSettingsChanged,
			onSendMessage,
			onCancelTurn,
			onLoadMessages,
			incomingMessages,
			incomingMessage,
			onCommit,
			onOpenPr,
			isCommitLoading = false,
			isOpenPrLoading = false,
			onMoveToTrash,
			isMoveToTrashLoading = false,
			onCancelAutomaticAction,
			cancelAutomaticActionLabel,
			showMoveToTrash = false,
		},
		ref,
	): ReactElement {
		const {
			draft,
			setDraft,
			messages,
			error,
			isSending,
			isLoadingHistory,
			canSend,
			canCancel,
			showReviewActions,
			showAgentProgressIndicator,
			showActionFooter,
			handleSendText,
			handleSendDraft,
			handleCancelTurn,
		} = useKanbanChatPanelController({
			taskId,
			summary,
			taskColumnId,
			onSendMessage,
			onCancelTurn,
			onLoadMessages,
			incomingMessages,
			incomingMessage,
			onCommit,
			onOpenPr,
			onMoveToTrash,
			onCancelAutomaticAction,
			cancelAutomaticActionLabel,
			showMoveToTrash,
		});
		// TODO: Persist per-task mode immediately when toggled so page refresh restores unsent mode changes.
		const modeByTaskIdRef = useRef<Map<string, RuntimeTaskSessionMode>>(new Map());
		const [composerError, setComposerError] = useState<string | null>(null);
		const [isSavingModel, setIsSavingModel] = useState(false);
		const [mode, setMode] = useState<RuntimeTaskSessionMode>(() => {
			const persistedMode = modeByTaskIdRef.current.get(taskId);
			return persistedMode ?? summary?.mode ?? defaultMode;
		});
		const [draftImages, setDraftImages] = useState<TaskImage[]>([]);
		const agentSettings = useRuntimeSettingsKanbanController({
			open: true,
			workspaceId,
			config: runtimeConfig,
			taskKanbanSettings,
		});

		const modelPickerOptions = useMemo(
			() => buildKanbanAgentModelPickerOptions(agentSettings.providerId, agentSettings.providerModels),
			[agentSettings.providerId, agentSettings.providerModels],
		);
		const modelOptions = modelPickerOptions.options;

		const selectedModel = useMemo(
			() => agentSettings.providerModels.find((model) => model.id === agentSettings.modelId) ?? null,
			[agentSettings.modelId, agentSettings.providerModels],
		);
		const reasoningEnabledModelIds = useMemo(
			() => getKanbanReasoningEnabledModelIds(agentSettings.providerModels),
			[agentSettings.providerModels],
		);

		const selectedModelButtonText = useMemo(
			() =>
				buildKanbanSelectedModelButtonText({
					modelOptions,
					selectedModelId: agentSettings.modelId,
					reasoningEffort: agentSettings.reasoningEffort,
					showReasoningEffort: agentSettings.selectedModelSupportsReasoningEffort,
					isModelLoading: agentSettings.isLoadingProviderModels,
					isModelSaving: isSavingModel,
				}),
			[
				agentSettings.isLoadingProviderModels,
				agentSettings.modelId,
				agentSettings.reasoningEffort,
				agentSettings.selectedModelSupportsReasoningEffort,
				isSavingModel,
				modelOptions,
			],
		);

		const panelError = composerError ?? error;
		const attachmentWarningMessage =
			draftImages.length > 0 && selectedModel?.supportsVision === false
				? "The selected Kanban model may not accept image input. Choose a vision-capable model to use these images."
				: null;

		useEffect(() => {
			setComposerError(null);
		}, [taskId]);

		const chatListContext = useMemo<KanbanChatListContext>(
			() => ({ showAgentProgressIndicator }),
			[showAgentProgressIndicator],
		);

		useEffect(() => {
			const persistedMode = modeByTaskIdRef.current.get(taskId);
			const nextMode = persistedMode ?? summary?.mode ?? defaultMode;
			modeByTaskIdRef.current.set(taskId, nextMode);
			setMode(nextMode);
			setDraftImages([]);
		}, [defaultMode, summary?.mode, taskId]);

		const handleModeChange = useCallback(
			(nextMode: RuntimeTaskSessionMode) => {
				modeByTaskIdRef.current.set(taskId, nextMode);
				setMode(nextMode);
			},
			[taskId],
		);

		type PersistKanbanModelSettingsOverrides = {
			modelId?: string;
			reasoningEffort?: RuntimeReasoningEffort | "";
		};

		const persistKanbanModelSettings = useCallback(
			async (overrides?: PersistKanbanModelSettingsOverrides): Promise<boolean> => {
				if (!workspaceId) {
					setComposerError("Select a workspace before choosing a Kanban model.");
					return false;
				}
				if (agentSettings.providerId.trim().length === 0) {
					setComposerError("Choose a Kanban provider in Settings before selecting a model.");
					return false;
				}
				setComposerError(null);
				setIsSavingModel(true);
				try {
					const nextModelId = overrides?.modelId ?? agentSettings.modelId;
					const nextReasoningEffort =
						overrides && "reasoningEffort" in overrides
							? overrides.reasoningEffort || ""
							: agentSettings.reasoningEffort;
					if (taskHasExplicitKanbanSettings) {
						onTaskKanbanSettingsChanged?.({
							providerId: agentSettings.providerId,
							modelId: nextModelId,
							reasoningEffort: nextReasoningEffort,
						});
						return true;
					}
					const result = await agentSettings.saveProviderSettings({
						modelId: nextModelId,
						reasoningEffort: nextReasoningEffort || null,
					});
					if (!result.ok) {
						setComposerError(result.message ?? "Could not save Kanban model settings.");
						return false;
					}
					onKanbanSettingsSaved?.();
					return true;
				} finally {
					setIsSavingModel(false);
				}
			},
			[
				agentSettings,
				onKanbanSettingsSaved,
				onTaskKanbanSettingsChanged,
				taskHasExplicitKanbanSettings,
				workspaceId,
			],
		);

		const handleSelectModel = useCallback(
			(nextModelId: string) => {
				if (nextModelId.trim() === agentSettings.modelId.trim()) {
					return;
				}
				agentSettings.setModelId(nextModelId);
				void persistKanbanModelSettings({ modelId: nextModelId });
			},
			[agentSettings.modelId, agentSettings.setModelId, persistKanbanModelSettings],
		);

		const handleSelectReasoningEffort = useCallback(
			(nextReasoningEffort: RuntimeReasoningEffort | "") => {
				if (nextReasoningEffort === agentSettings.reasoningEffort) {
					return;
				}
				agentSettings.setReasoningEffort(nextReasoningEffort);
				void persistKanbanModelSettings({ reasoningEffort: nextReasoningEffort });
			},
			[agentSettings.reasoningEffort, agentSettings.setReasoningEffort, persistKanbanModelSettings],
		);

		const handleAppendToDraft = useCallback(
			(text: string) => {
				setDraft(appendTranscriptToDraft(draft, text));
			},
			[draft, setDraft],
		);

		const handleSendComposerText = useCallback(
			async (text: string): Promise<void> => {
				if (isSavingModel) {
					return;
				}
				if (agentSettings.hasUnsavedChanges) {
					const saved = await persistKanbanModelSettings();
					if (!saved) {
						return;
					}
				}
				await handleSendText(text, mode);
			},
			[agentSettings.hasUnsavedChanges, handleSendText, isSavingModel, mode, persistKanbanModelSettings],
		);

		useImperativeHandle(
			ref,
			() => ({
				appendToDraft: handleAppendToDraft,
				sendText: handleSendComposerText,
			}),
			[handleAppendToDraft, handleSendComposerText],
		);

		const handleComposerSend = useCallback(async () => {
			if (isSavingModel) {
				return;
			}
			if (agentSettings.hasUnsavedChanges) {
				const saved = await persistKanbanModelSettings();
				if (!saved) {
					return;
				}
			}
			const sent = await handleSendDraft(mode, draftImages);
			if (sent) {
				setDraftImages([]);
			}
		}, [
			agentSettings.hasUnsavedChanges,
			draftImages,
			handleSendDraft,
			isSavingModel,
			mode,
			persistKanbanModelSettings,
		]);

		// Only show the history skeleton on the very first load, before any
		// message has arrived. Once messages exist (history loaded, streaming, or
		// freshly sent), the live list — with its own send/stream indicators —
		// takes over, so the skeleton never flashes mid-conversation.
		const showHistorySkeleton = isLoadingHistory && messages.length === 0;

		return (
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{showHistorySkeleton ? (
					<KanbanChatHistorySkeleton />
				) : (
					<Virtuoso
						key={taskId}
						data={messages}
						className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
						followOutput="auto"
						alignToBottom
						atBottomThreshold={BOTTOM_LOCK_THRESHOLD_PX}
						initialTopMostItemIndex={Math.max(0, messages.length - 1)}
						computeItemKey={computeKanbanChatMessageKey}
						itemContent={renderKanbanChatMessageItem}
						context={chatListContext}
						components={KANBAN_CHAT_LIST_COMPONENTS}
					/>
				)}
				{panelError ? (
					<div className="border-t border-status-red/30 bg-status-red/10 px-2 py-2 text-xs text-status-red">
						{panelError}
					</div>
				) : null}
				{suggestionSlot ? <div className="px-2 pt-2">{suggestionSlot}</div> : null}
				<div className="px-2 py-3">
					<KanbanChatComposer
						taskId={taskId}
						draft={draft}
						onDraftChange={setDraft}
						images={draftImages}
						onImagesChange={setDraftImages}
						placeholder={composerPlaceholder}
						mode={mode}
						onModeChange={handleModeChange}
						showModeToggle={showComposerModeToggle}
						canSend={canSend}
						canCancel={canCancel}
						onSend={handleComposerSend}
						onCancel={handleCancelTurn}
						modelOptions={modelOptions}
						recommendedModelIds={modelPickerOptions.recommendedModelIds}
						pinSelectedModelToTop={modelPickerOptions.shouldPinSelectedModelToTop}
						selectedModelId={agentSettings.modelId}
						selectedModelButtonText={selectedModelButtonText}
						onSelectModel={handleSelectModel}
						reasoningEnabledModelIds={reasoningEnabledModelIds}
						selectedReasoningEffort={agentSettings.reasoningEffort}
						onSelectReasoningEffort={handleSelectReasoningEffort}
						isModelLoading={agentSettings.isLoadingProviderModels}
						isModelSaving={isSavingModel}
						modelPickerDisabled={isSavingModel || agentSettings.providerId.trim().length === 0}
						isSending={isSavingModel || isSending}
						warningMessage={summary?.warningMessage ?? null}
						attachmentWarningMessage={attachmentWarningMessage}
						workspaceId={workspaceId}
						modelControlSlot={modelControlSlot}
					/>
				</div>
				{showActionFooter ? (
					<div className="flex flex-col gap-2 px-3 pb-3">
						{showReviewActions ? (
							<div className="flex gap-2">
								<Button
									variant="primary"
									size="sm"
									fill
									disabled={isCommitLoading || isOpenPrLoading}
									onClick={onCommit}
								>
									{isCommitLoading ? "..." : "Commit"}
								</Button>
								<Button
									variant="primary"
									size="sm"
									fill
									disabled={isCommitLoading || isOpenPrLoading}
									onClick={onOpenPr}
								>
									{isOpenPrLoading ? "..." : "Open PR"}
								</Button>
							</div>
						) : null}
						{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
							<Button variant="default" fill onClick={onCancelAutomaticAction}>
								{cancelAutomaticActionLabel}
							</Button>
						) : null}
						<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
							{isMoveToTrashLoading ? <Spinner size={14} /> : "Move Card To Done"}
						</Button>
					</div>
				) : null}
			</div>
		);
	},
);

KanbanAgentChatPanel.displayName = "KanbanAgentChatPanel";
