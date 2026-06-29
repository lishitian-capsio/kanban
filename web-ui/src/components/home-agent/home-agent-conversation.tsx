// The conversation surface for one home chat thread.
//
// Given the active thread, this decides whether to render the native Kanban chat
// (pi) or a terminal panel and wires it to the shared runtime actions, the per-thread
// session-provider override, and the agent-proposed next-step chip. It owns the
// session-summary fold-in and subscribes the thread's chat channel in its own fiber,
// so streaming tokens re-render only this surface, never App.
//
// It is the shared body behind BOTH home presentations (decision 1902b): the compact
// sidebar (`HomeSidebarAgentPanel`, active = thread bar selection) and the fullscreen
// workspace (`HomeChatWorkspace`, active = the active session tab). Only one is mounted
// at a time (the dockable panel renders one layout), so there is no double subscription.
import type { ReactElement } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { SessionProviderControl } from "@/components/agent-providers/session-provider-control";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import {
	KanbanAgentChatPanel,
	type KanbanAgentChatPanelHandle,
} from "@/components/detail-panels/kanban-agent-chat-panel";
import { AgentAvatar, resolveAgentLabel } from "@/components/home-agent/agent-icon";
import { HomeNextStepSuggestion } from "@/components/home-agent/home-next-step-suggestion";
import { TerminalAgentHints } from "@/components/home-agent/terminal-agent-hints";
import { createIdleTaskSession } from "@/hooks/app-utils";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import { type HomeAgentActiveThread, useHomeAgentSession } from "@/hooks/use-home-agent-session";
import type { HomeThread } from "@/hooks/use-home-threads";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useKanbanChatRuntimeActions } from "@/hooks/use-kanban-chat-runtime-actions";
import {
	useLatestTaskChatMessageForTask,
	useRuntimeKanbanSessionContextVersion,
	useRuntimeWorkspaceState,
	useTaskChatMessages,
} from "@/runtime/runtime-stream-store";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";
import { useTerminalThemeColors } from "@/terminal/theme-colors";
import { useVoiceCommandController } from "@/voice-command/use-voice-command-controller";
import type { VoiceCommandBoard } from "@/voice-command/voice-command";
import { VoiceCommandConfirmDialog } from "@/voice-command/voice-command-confirm-dialog";

interface HomeAgentConversationProps {
	/** The thread whose conversation to show. Null renders a neutral "no session" state. */
	activeThread: HomeThread | null;
	currentProjectId: string;
	runtimeProjectConfig: RuntimeConfigResponse;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	/** Optimistically clear the thread's pending next-step chip when the user sends a message. */
	onClearNextStep: (threadId: string) => void;
}

export function HomeAgentConversation({
	activeThread,
	currentProjectId,
	runtimeProjectConfig,
	taskSessions,
	workspaceGit,
	onClearNextStep,
}: HomeAgentConversationProps): ReactElement {
	const isMobile = useIsMobile();
	const terminalThemeColors = useTerminalThemeColors();
	const kanbanSessionContextVersion = useRuntimeKanbanSessionContextVersion();
	const [sessionSummaries, setSessionSummaries] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	// Per-thread session provider override (keyed by the thread's task id). Picking a
	// provider in the composer pins it for that one thread's next session launch; it
	// never changes the agent default and never touches another thread's session.
	const [providerOverrideByTaskId, setProviderOverrideByTaskId] = useState<Record<string, string>>({});
	const upsertSessionSummary = useCallback((summary: RuntimeTaskSessionSummary) => {
		setSessionSummaries((currentSessions) => {
			const previousSummary = currentSessions[summary.taskId] ?? null;
			const newestSummary = selectNewestTaskSessionSummary(previousSummary, summary);
			if (newestSummary !== summary) {
				return currentSessions;
			}
			return {
				...currentSessions,
				[summary.taskId]: newestSummary,
			};
		});
	}, []);
	const effectiveSessionSummaries = useMemo(() => {
		const mergedSessionSummaries = { ...taskSessions };
		for (const [taskId, summary] of Object.entries(sessionSummaries)) {
			const newestSummary = selectNewestTaskSessionSummary(mergedSessionSummaries[taskId] ?? null, summary);
			if (newestSummary) {
				mergedSessionSummaries[taskId] = newestSummary;
			}
		}
		return mergedSessionSummaries;
	}, [sessionSummaries, taskSessions]);

	const homeAgentActiveThread = useMemo<HomeAgentActiveThread | null>(() => {
		if (!activeThread) {
			return null;
		}
		return { id: activeThread.id, agentId: activeThread.agentId };
	}, [activeThread]);

	const { panelMode, taskId } = useHomeAgentSession({
		currentProjectId,
		runtimeProjectConfig,
		activeThread: homeAgentActiveThread,
		workspaceGit,
		kanbanSessionContextVersion,
		sessionSummaries: effectiveSessionSummaries,
		setSessionSummaries,
		upsertSessionSummary,
	});

	const { sendTaskChatMessage, loadTaskChatMessages, cancelTaskChatTurn } = useKanbanChatRuntimeActions({
		currentProjectId,
		onSessionSummary: upsertSessionSummary,
	});

	const activeAgentId = activeThread?.agentId ?? null;
	const selectedAgentLabel = useMemo(() => {
		if (!activeAgentId) {
			return "selected agent";
		}
		return resolveAgentLabel(runtimeProjectConfig.agents, activeAgentId);
	}, [runtimeProjectConfig, activeAgentId]);

	const homeAgentPanelSummary = taskId ? (effectiveSessionSummaries[taskId] ?? null) : null;
	// Subscribe to the active thread's chat channel directly so streaming tokens
	// only re-render this surface, not App.
	const homeTaskChatMessages = useTaskChatMessages(taskId);
	const latestHomeTaskChatMessage = useLatestTaskChatMessageForTask(taskId);

	const chatPanelRef = useRef<KanbanAgentChatPanelHandle>(null);
	const activeThreadIdForClear = activeThread?.id ?? null;
	const activeThreadIsDefault = activeThread?.isDefault ?? true;
	const pendingNextStep = activeThread?.pendingNextStep ?? null;

	const handleSendHomeKanbanChatMessage = useCallback(
		async (messageTaskId: string, text: string, options?: { mode?: "act" | "plan" }) => {
			// Any send (typed or via the suggestion chip) supersedes a pending next-step
			// suggestion — drop the chip locally the instant we send; the backend clears the
			// persisted value too.
			if (activeThreadIdForClear && !activeThreadIsDefault) {
				onClearNextStep(activeThreadIdForClear);
			}
			const providerId = providerOverrideByTaskId[messageTaskId];
			return await sendTaskChatMessage(messageTaskId, text, {
				...options,
				...(providerId ? { providerId } : {}),
			});
		},
		[activeThreadIdForClear, activeThreadIsDefault, onClearNextStep, providerOverrideByTaskId, sendTaskChatMessage],
	);

	// Clicking the chip sends its text through the SAME path as typing it and pressing enter
	// (the panel's imperative composer-send), so the agent proceeds with the next step.
	const handleSendNextStep = useCallback((suggestion: string) => {
		void chatPanelRef.current?.sendText(suggestion);
	}, []);

	// Voice-command control of the board: command-mode transcripts are parsed locally,
	// confirmed, then sent as an id-qualified instruction down the SAME agent path the
	// next-step chip uses. Resolves spoken task/column refs against the live board.
	const workspaceState = useRuntimeWorkspaceState();
	const voiceCommandBoard = useMemo<VoiceCommandBoard | null>(() => workspaceState?.board ?? null, [workspaceState]);
	const handleExecuteVoiceCommand = useCallback((instruction: string) => {
		void chatPanelRef.current?.sendText(instruction);
	}, []);
	const handleFillDraftFromVoice = useCallback((text: string) => {
		chatPanelRef.current?.appendToDraft(text);
	}, []);
	const voiceCommand = useVoiceCommandController({
		board: voiceCommandBoard,
		onExecute: handleExecuteVoiceCommand,
		onFillDraft: handleFillDraftFromVoice,
	});

	const nextStepSuggestionSlot = useMemo(
		() =>
			pendingNextStep ? <HomeNextStepSuggestion suggestion={pendingNextStep} onSend={handleSendNextStep} /> : null,
		[pendingNextStep, handleSendNextStep],
	);

	const handleLoadHomeKanbanChatMessages = useCallback(
		async (messageTaskId: string) => await loadTaskChatMessages(messageTaskId),
		[loadTaskChatMessages],
	);

	const handleCancelHomeKanbanChatTurn = useCallback(
		async (messageTaskId: string) => await cancelTaskChatTurn(messageTaskId),
		[cancelTaskChatTurn],
	);

	let body: ReactElement;
	if (panelMode === "chat" && taskId) {
		body = (
			<KanbanAgentChatPanel
				key={taskId}
				ref={chatPanelRef}
				taskId={taskId}
				summary={homeAgentPanelSummary ?? createIdleTaskSession(taskId)}
				defaultMode="act"
				showComposerModeToggle={false}
				workspaceId={currentProjectId}
				runtimeConfig={runtimeProjectConfig}
				suggestionSlot={nextStepSuggestionSlot}
				modelControlSlot={
					// The active conversation is the one place the agent's full name appears in
					// prose (the tabs/cards only show its icon). Agent + provider + model read as a
					// single "who is answering" group, so the name sits inline before the provider
					// switch rather than in a separate header layer.
					<div className="flex min-w-0 items-center gap-2">
						<span className="flex min-w-0 shrink items-center gap-1.5 text-[13px]">
							{/* Agent-type identity (⑤): the same boxed avatar treatment as the thread
							    surfaces, leading the agent's full name. No status badge — this header
							    answers "who is answering", not a specific thread's health. */}
							{activeAgentId ? (
								<AgentAvatar agents={runtimeProjectConfig.agents} agentId={activeAgentId} size="sm" />
							) : null}
							<span className="min-w-0 truncate font-medium text-text-primary">{selectedAgentLabel}</span>
						</span>
						<SessionProviderControl
							workspaceId={currentProjectId}
							agentId={activeAgentId}
							selectedProviderId={providerOverrideByTaskId[taskId] ?? null}
							onSelectProvider={(providerId) =>
								setProviderOverrideByTaskId((previous) => ({ ...previous, [taskId]: providerId }))
							}
						/>
					</div>
				}
				onSendMessage={handleSendHomeKanbanChatMessage}
				onCancelTurn={handleCancelHomeKanbanChatTurn}
				onLoadMessages={handleLoadHomeKanbanChatMessages}
				incomingMessage={latestHomeTaskChatMessage}
				incomingMessages={homeTaskChatMessages}
				onVoiceCommand={voiceCommand.handleTranscript}
				composerPlaceholder="Ask Kanban to add, edit, start, or link tasks"
			/>
		);
	} else if (panelMode === "terminal" && taskId) {
		body = (
			<AgentTerminalPanel
				key={taskId}
				taskId={taskId}
				workspaceId={currentProjectId}
				summary={homeAgentPanelSummary}
				onSummary={upsertSessionSummary}
				showSessionToolbar={false}
				autoFocus={!isMobile}
				panelBackgroundColor="var(--color-surface-1)"
				terminalBackgroundColor={terminalThemeColors.surfaceRaised}
				cursorColor={terminalThemeColors.textPrimary}
			/>
		);
	} else if (activeAgentId !== null && activeAgentId !== "pi") {
		body = (
			<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-center text-sm text-text-secondary">
				No runnable {selectedAgentLabel} command is configured. Open Settings, install the CLI, and select it.
			</div>
		);
	} else {
		body = (
			<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-center text-sm text-text-secondary">
				Select a Kanban provider in Settings to start a home chat session.
			</div>
		);
	}

	return (
		<div className="flex h-full w-full min-h-0 flex-col gap-2">
			{activeAgentId && activeAgentId !== "pi" ? <TerminalAgentHints /> : null}
			<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">{body}</div>
			<VoiceCommandConfirmDialog
				pending={voiceCommand.pending}
				onConfirm={voiceCommand.confirm}
				onCancel={voiceCommand.cancel}
			/>
		</div>
	);
}
