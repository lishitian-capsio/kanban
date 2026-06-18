// Composes the sidebar agent surface for the current workspace.
//
// It renders the multi-thread switcher (HomeThreadBar) and, for the active
// thread, decides whether to render the native Kanban chat or a terminal panel
// and wires that surface to shared runtime actions. Threads run in parallel, so
// switching never tears down another thread's session.
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { SessionProviderControl } from "@/components/agent-providers/session-provider-control";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { KanbanAgentChatPanel } from "@/components/detail-panels/kanban-agent-chat-panel";
import { HomeThreadBar } from "@/components/home-agent/home-thread-bar";
import { TerminalAgentHints } from "@/components/home-agent/terminal-agent-hints";
import { resolveAgentLabel } from "@/components/home-agent/thread-agent-badge";
import { Spinner } from "@/components/ui/spinner";
import { createIdleTaskSession } from "@/hooks/app-utils";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import { type HomeAgentActiveThread, useHomeAgentSession } from "@/hooks/use-home-agent-session";
import type { UseHomeThreadsResult } from "@/hooks/use-home-threads";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useKanbanChatRuntimeActions } from "@/hooks/use-kanban-chat-runtime-actions";
import { selectLatestTaskChatMessageForTask } from "@/runtime/native-agent";
import type {
	RuntimeConfigResponse,
	RuntimeGitRepositoryInfo,
	RuntimeStateStreamTaskChatMessage,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import { useTerminalThemeColors } from "@/terminal/theme-colors";

interface UseHomeSidebarAgentPanelInput {
	currentProjectId: string | null;
	hasNoProjects: boolean;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	homeThreads: UseHomeThreadsResult;
	kanbanSessionContextVersion: number;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	latestTaskChatMessage: RuntimeStateStreamTaskChatMessage | null;
	taskChatMessagesByTaskId: Record<string, RuntimeTaskChatMessage[]>;
}

export function useHomeSidebarAgentPanel({
	currentProjectId,
	hasNoProjects,
	runtimeProjectConfig,
	homeThreads,
	kanbanSessionContextVersion,
	taskSessions,
	workspaceGit,
	latestTaskChatMessage,
	taskChatMessagesByTaskId,
}: UseHomeSidebarAgentPanelInput): ReactElement | null {
	const isMobile = useIsMobile();
	const terminalThemeColors = useTerminalThemeColors();
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

	const activeThread = useMemo<HomeAgentActiveThread | null>(() => {
		if (!homeThreads.activeThread) {
			return null;
		}
		return { id: homeThreads.activeThread.id, agentId: homeThreads.activeThread.agentId };
	}, [homeThreads.activeThread]);

	const { panelMode, taskId } = useHomeAgentSession({
		currentProjectId,
		runtimeProjectConfig,
		activeThread,
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

	const activeAgentId = homeThreads.activeThread?.agentId ?? null;
	const selectedAgentLabel = useMemo(() => {
		if (!runtimeProjectConfig || !activeAgentId) {
			return "selected agent";
		}
		return resolveAgentLabel(runtimeProjectConfig.agents, activeAgentId);
	}, [runtimeProjectConfig, activeAgentId]);

	const homeAgentPanelSummary = taskId ? (effectiveSessionSummaries[taskId] ?? null) : null;
	const homeTaskChatMessages = taskId ? (taskChatMessagesByTaskId[taskId] ?? null) : null;
	const latestHomeTaskChatMessage = selectLatestTaskChatMessageForTask(taskId, latestTaskChatMessage);

	const handleSendHomeKanbanChatMessage = useCallback(
		async (messageTaskId: string, text: string, options?: { mode?: "act" | "plan" }) => {
			const providerId = providerOverrideByTaskId[messageTaskId];
			return await sendTaskChatMessage(messageTaskId, text, {
				...options,
				...(providerId ? { providerId } : {}),
			});
		},
		[providerOverrideByTaskId, sendTaskChatMessage],
	);

	const handleLoadHomeKanbanChatMessages = useCallback(
		async (messageTaskId: string) => await loadTaskChatMessages(messageTaskId),
		[loadTaskChatMessages],
	);

	const handleCancelHomeKanbanChatTurn = useCallback(
		async (messageTaskId: string) => await cancelTaskChatTurn(messageTaskId),
		[cancelTaskChatTurn],
	);

	if (hasNoProjects || !currentProjectId) {
		return null;
	}

	if (!runtimeProjectConfig) {
		return (
			<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 py-6">
				<Spinner size={20} />
			</div>
		);
	}

	let body: ReactElement;
	if (panelMode === "chat" && taskId) {
		body = (
			<KanbanAgentChatPanel
				key={taskId}
				taskId={taskId}
				summary={homeAgentPanelSummary ?? createIdleTaskSession(taskId)}
				defaultMode="act"
				showComposerModeToggle={false}
				workspaceId={currentProjectId}
				runtimeConfig={runtimeProjectConfig}
				modelControlSlot={
					<SessionProviderControl
						workspaceId={currentProjectId}
						agentId={activeAgentId}
						selectedProviderId={providerOverrideByTaskId[taskId] ?? null}
						onSelectProvider={(providerId) =>
							setProviderOverrideByTaskId((previous) => ({ ...previous, [taskId]: providerId }))
						}
					/>
				}
				onSendMessage={handleSendHomeKanbanChatMessage}
				onCancelTurn={handleCancelHomeKanbanChatTurn}
				onLoadMessages={handleLoadHomeKanbanChatMessages}
				incomingMessage={latestHomeTaskChatMessage}
				incomingMessages={homeTaskChatMessages}
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
	} else if (activeAgentId !== "pi") {
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
			<div className="flex items-stretch gap-1">
				<div className="min-w-0 flex-1">
					<HomeThreadBar
						threads={homeThreads.threads}
						activeThreadId={homeThreads.activeThreadId}
						agents={runtimeProjectConfig.agents}
						defaultAgentId={runtimeProjectConfig.selectedAgentId}
						onSelectThread={homeThreads.setActiveThread}
						onCreateThread={homeThreads.createThread}
						onRenameThread={homeThreads.renameThread}
						onCloseThread={homeThreads.closeThread}
					/>
				</div>
			</div>
			<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">{body}</div>
		</div>
	);
}
