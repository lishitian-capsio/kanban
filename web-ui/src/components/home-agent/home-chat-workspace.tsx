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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HomeAddSessionCard } from "@/components/home-agent/home-add-session-card";
import { HomeAgentConversation } from "@/components/home-agent/home-agent-conversation";
import { HomeSessionCard } from "@/components/home-agent/home-session-card";
import { HomeThreadCloseDialog } from "@/components/home-agent/home-thread-close-dialog";
import { SessionTabStrip } from "@/components/home-agent/session-tab-strip";
import type { HomeThread, UseHomeThreadsResult } from "@/hooks/use-home-threads";
import { useRefreshHomeThreadsOnSessionContextBump } from "@/hooks/use-refresh-home-threads-on-context-bump";
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

	// Hard-delete a session (stop the agent + delete its transcript). Reuses the exact compact
	// flow: a confirmation dialog → homeThreads.closeThread, which also prunes any open tab.
	const [closeTarget, setCloseTarget] = useState<HomeThread | null>(null);

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

	const { activeThreadId, openThreadIds } = homeThreads.fullscreenTabs;
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
									currentProjectId={currentProjectId}
									onOpenSession={homeThreads.openSessionTab}
									onDeleteSession={setCloseTarget}
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

			<HomeThreadCloseDialog
				thread={closeTarget}
				onOpenChange={(open) => {
					if (!open) {
						setCloseTarget(null);
					}
				}}
				onClose={homeThreads.closeThread}
			/>
		</div>
	);
}
