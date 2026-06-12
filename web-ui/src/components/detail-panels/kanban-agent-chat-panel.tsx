// Layout component for the native Kanban chat panel.
// Rendering lives here, while session state and action wiring come from the
// controller hook so multiple surfaces can share the same behavior.

import { AlertTriangle } from "lucide-react";
import React, {
	type ReactElement,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { AgentProfileControl } from "@/components/agent-profiles/agent-profile-control";
import { KanbanChatComposer } from "@/components/detail-panels/kanban-chat-composer";
import { KanbanChatMessageItem } from "@/components/detail-panels/kanban-chat-message-item";
import {
	buildKanbanAgentModelPickerOptions,
	buildKanbanSelectedModelButtonText,
	getKanbanReasoningEnabledModelIds,
} from "@/components/detail-panels/kanban-model-picker-options";
import { KanbanThinkingIndicator } from "@/components/detail-panels/kanban-thinking-indicator";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Spinner } from "@/components/ui/spinner";
import { useKanbanChatPanelController } from "@/hooks/use-kanban-chat-panel-controller";
import type { KanbanChatActionResult } from "@/hooks/use-kanban-chat-runtime-actions";
import type { KanbanChatMessage } from "@/hooks/use-kanban-chat-session";
import { useRuntimeSettingsKanbanController } from "@/hooks/use-runtime-settings-kanban-controller";
import type {
	RuntimeAgentId,
	RuntimeReasoningEffort,
	RuntimeConfigResponse,
	RuntimeTaskAgentSettings,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { TaskImage } from "@/types";

const BOTTOM_LOCK_THRESHOLD_PX = 24;
const KANBAN_BUY_CREDITS_URL = "https://app.cline.bot/";

const KanbanCreditLimitNotice = React.memo(function KanbanCreditLimitNotice() {
	return (
		<div className="mx-1 flex items-start gap-2 rounded-md border border-status-orange/40 bg-status-orange/10 px-3 py-2 text-xs text-status-orange">
			<AlertTriangle size={14} className="mt-0.5 shrink-0" />
			<p className="m-0 min-w-0">
				Out of Kanban credits.{" "}
				<Link href={KANBAN_BUY_CREDITS_URL} external>
					Buy more credits
				</Link>{" "}
				to continue.
			</p>
		</div>
	);
});

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
	// When set, the composer shows the per-agent config profile control (switch /
	// edit / new / duplicate / rename / delete) scoped to `profileAgentId`,
	// replacing the bare model selector. Used by the home sidebar chat.
	agentProfilesEnabled?: boolean;
	profileAgentId?: RuntimeAgentId | null;
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
			agentProfilesEnabled = false,
			profileAgentId = null,
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
			canSend,
			canCancel,
			showReviewActions,
			showAgentProgressIndicator,
			showActionFooter,
			showCancelAutomaticAction,
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
		const scrollContainerRef = useRef<HTMLDivElement | null>(null);
		// TODO: Persist per-task mode immediately when toggled so page refresh restores unsent mode changes.
		const modeByTaskIdRef = useRef<Map<string, RuntimeTaskSessionMode>>(new Map());
		const [composerError, setComposerError] = useState<string | null>(null);
		const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
		const [isSavingModel, setIsSavingModel] = useState(false);
		const isCreditLimitNoticeVisible = summary?.latestHookActivity?.notificationType === "credit_limit";
		const [mode, setMode] = useState<RuntimeTaskSessionMode>(() => {
			const persistedMode = modeByTaskIdRef.current.get(taskId);
			return persistedMode ?? summary?.mode ?? defaultMode;
		});
		const [draftImages, setDraftImages] = useState<TaskImage[]>([]);
		const agentSettings = useRuntimeSettingsKanbanController({
			open: true,
			workspaceId,
			selectedAgentId: "pi",
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

		const isPinnedToBottom = useCallback((container: HTMLDivElement): boolean => {
			const remainingDistance = container.scrollHeight - container.scrollTop - container.clientHeight;
			return remainingDistance <= BOTTOM_LOCK_THRESHOLD_PX;
		}, []);

		const handleMessageListScroll = useCallback(() => {
			const container = scrollContainerRef.current;
			if (!container) {
				return;
			}
			const nextIsAutoScrollEnabled = isPinnedToBottom(container);
			setIsAutoScrollEnabled((currentValue) =>
				currentValue === nextIsAutoScrollEnabled ? currentValue : nextIsAutoScrollEnabled,
			);
		}, [isPinnedToBottom]);

		useLayoutEffect(() => {
			const container = scrollContainerRef.current;
			if (!container || !isAutoScrollEnabled) {
				return;
			}
			container.scrollTop = container.scrollHeight;
		}, [
			isAutoScrollEnabled,
			messages,
			showAgentProgressIndicator,
			showActionFooter,
			showReviewActions,
			showCancelAutomaticAction,
		]);

		useEffect(() => {
			setComposerError(null);
		}, [taskId]);

		useEffect(() => {
			setIsAutoScrollEnabled(true);
		}, [taskId]);

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
			[agentSettings, onKanbanSettingsSaved, onTaskKanbanSettingsChanged, taskHasExplicitKanbanSettings, workspaceId],
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
				const trimmed = text.trim();
				if (trimmed.length === 0) {
					return;
				}
				if (draft.trim().length === 0) {
					setDraft(trimmed);
					return;
				}
				setDraft(`${draft.trimEnd()}\n\n${trimmed}`);
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

		return (
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div
					ref={scrollContainerRef}
					className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto px-2 py-3"
					onScroll={handleMessageListScroll}
				>
					{messages.map((message) => (
						<KanbanChatMessageItem key={message.id} message={message} />
					))}
					{showAgentProgressIndicator ? <KanbanThinkingIndicator /> : null}
					{isCreditLimitNoticeVisible ? <KanbanCreditLimitNotice /> : null}
				</div>
				{panelError ? (
					<div className="border-t border-status-red/30 bg-status-red/10 px-2 py-2 text-xs text-status-red">
						{panelError}
					</div>
				) : null}
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
						modelControlSlot={
							agentProfilesEnabled && profileAgentId ? (
								<AgentProfileControl
									workspaceId={workspaceId}
									agentId={profileAgentId}
									disabled={isSavingModel}
								/>
							) : null
						}
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
