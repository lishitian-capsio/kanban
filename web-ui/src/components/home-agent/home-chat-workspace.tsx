// The fullscreen presentation of the home agent chat (decision 1902b).
//
// When the dockable panel is in its `fullscreen` state, the layout selector
// (`selectHomeChatLayout`) mounts this workspace instead of the compact thread-bar
// surface. It is a Home-tab + session-tab workspace:
//   - a permanent **Home tab** (the launcher): a dashboard grid of session cards, one per
//     home chat thread, with a fixed "+" add-session card last;
//   - **coexisting session tabs**: clicking a card opens that conversation as its own tab to
//     the right of the Home tab, and the tab strip switches between them horizontally.
//
// Both the cards and the conversation draw from the same per-workspace thread registry as the
// compact surface, so the session data model is untouched — only the open-tab set + active tab
// are persisted (as view state) on the registry. Closing a tab is a UI-only collapse back to
// Home, never a thread hard-close. The active conversation reuses the SAME HomeAgentConversation
// as the compact sidebar, so a session never tears down when switching presentations.
import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { notifyError } from "@/components/app-toaster";
import { HomeAddSessionCard } from "@/components/home-agent/home-add-session-card";
import { HomeAgentConversation } from "@/components/home-agent/home-agent-conversation";
import { HomeSessionCard } from "@/components/home-agent/home-session-card";
import { SessionTabStrip } from "@/components/home-agent/session-tab-strip";
import type { UseHomeThreadsResult } from "@/hooks/use-home-threads";
import { useRefreshHomeThreadsOnSessionContextBump } from "@/hooks/use-refresh-home-threads-on-context-bump";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";

interface HomeChatWorkspaceProps {
	currentProjectId: string | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	homeThreads: UseHomeThreadsResult;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
}

export function HomeChatWorkspace({
	currentProjectId,
	runtimeProjectConfig,
	homeThreads,
	taskSessions,
	workspaceGit,
}: HomeChatWorkspaceProps): ReactElement | null {
	// Keep agent-set titles fresh in the launcher cards + tab strip (mirrors the compact panel).
	useRefreshHomeThreadsOnSessionContextBump(homeThreads.refresh);

	// Continuity rule, docked → fullscreen: restore the persisted tab set, seeding the current
	// docked conversation as the first tab when none is persisted. Run once on mount (= entering
	// fullscreen; the dockable panel only mounts this workspace in the fullscreen layout). Read the
	// callback through a ref so a changing callback identity does not re-seed mid-session.
	const reconcileRef = useRef(homeThreads.reconcileFullscreenTabsOnEnter);
	reconcileRef.current = homeThreads.reconcileFullscreenTabsOnEnter;
	useEffect(() => {
		reconcileRef.current();
	}, []);

	// Pre-resolve each thread's synthetic session id so the cards (and the session
	// lookup) agree on the same identity the active surface uses.
	const sessionCards = useMemo(() => {
		if (!currentProjectId) {
			return [];
		}
		return homeThreads.threads.map((thread) => ({
			thread,
			taskId: createHomeAgentSessionId(currentProjectId, thread.agentId, thread.id),
		}));
	}, [currentProjectId, homeThreads.threads]);

	// Creating from the "+" card opens the new session straight into its own tab (the
	// browser-new-tab idiom), not just the launcher grid.
	const { createThread, openSessionTab } = homeThreads;
	const handleCreateSession = useCallback(
		async (input: Parameters<UseHomeThreadsResult["createThread"]>[0]) => {
			const createdThreadId = await createThread(input);
			if (createdThreadId) {
				openSessionTab(createdThreadId);
			}
		},
		[createThread, openSessionTab],
	);

	// Restart an errored session by re-launching its agent. Mirrors the lazy launch in
	// use-home-agent-session (same baseRef + geometry); the refreshed summary reaches the
	// cards through the runtime broadcast, so no local summary plumbing is needed here.
	const { renameThread, closeThread } = homeThreads;
	const handleRestartSession = useCallback(
		async (threadId: string) => {
			if (!currentProjectId) {
				return;
			}
			const card = sessionCards.find((entry) => entry.thread.id === threadId);
			if (!card) {
				return;
			}
			const baseRef = workspaceGit?.currentBranch ?? workspaceGit?.defaultBranch ?? "HEAD";
			const geometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);
			try {
				const response = await getRuntimeTrpcClient(currentProjectId).runtime.startTaskSession.mutate({
					taskId: card.taskId,
					prompt: "",
					baseRef,
					cols: geometry.cols,
					rows: geometry.rows,
				});
				if (!response.ok) {
					throw new Error(response.error ?? "Could not restart the session.");
				}
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			}
		},
		[currentProjectId, sessionCards, workspaceGit],
	);

	const { activeThreadId, openThreadIds } = homeThreads.fullscreenTabs;
	// Threads already open in a session tab get the accent "already open" highlight on
	// their launcher card (mirrors the board task card's selected styling).
	const openThreadIdSet = useMemo(() => new Set(openThreadIds), [openThreadIds]);
	const activeTabThread = useMemo(
		() => (activeThreadId === null ? null : (homeThreads.threads.find((t) => t.id === activeThreadId) ?? null)),
		[activeThreadId, homeThreads.threads],
	);

	if (!currentProjectId || !runtimeProjectConfig) {
		return null;
	}

	// The Home tab shows when no session tab is active, or when the active tab's thread is gone.
	const showHomeTab = activeTabThread === null;

	return (
		<div className="flex h-full min-h-0 w-full flex-col gap-2">
			<SessionTabStrip
				threads={homeThreads.threads}
				openThreadIds={openThreadIds}
				activeThreadId={activeTabThread ? activeThreadId : null}
				agents={runtimeProjectConfig.agents}
				onActivateHome={homeThreads.activateHomeTab}
				onActivateTab={homeThreads.activateSessionTab}
				onCloseTab={homeThreads.closeSessionTab}
			/>

			{showHomeTab ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="shrink-0 px-1 pb-3">
						<h2 className="text-sm font-semibold text-text-primary">Sessions</h2>
						<p className="mt-0.5 text-xs text-text-secondary">
							Your Kanban Agent conversations. Open one, or start a new session.
						</p>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
						<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
							{sessionCards.map(({ thread, taskId }) => (
								<HomeSessionCard
									key={thread.id}
									thread={thread}
									taskId={taskId}
									agents={runtimeProjectConfig.agents}
									summary={taskSessions[taskId] ?? null}
									isOpen={openThreadIdSet.has(thread.id)}
									currentProjectId={currentProjectId}
									onOpenSession={homeThreads.openSessionTab}
									onRename={renameThread}
									onClose={closeThread}
									onRestart={handleRestartSession}
								/>
							))}
							<HomeAddSessionCard
								agents={runtimeProjectConfig.agents}
								defaultAgentId={runtimeProjectConfig.selectedAgentId}
								onCreate={handleCreateSession}
							/>
						</div>
					</div>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">
					<HomeAgentConversation
						activeThread={activeTabThread}
						currentProjectId={currentProjectId}
						runtimeProjectConfig={runtimeProjectConfig}
						taskSessions={taskSessions}
						workspaceGit={workspaceGit}
						onClearNextStep={homeThreads.clearNextStep}
					/>
				</div>
			)}
		</div>
	);
}
