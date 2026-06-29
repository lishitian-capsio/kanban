// The fullscreen presentation of the home agent chat (decision 1902b).
//
// Mounted (instead of the compact thread-bar surface) whenever the home chat is in its
// fullscreen state — an orthogonal axis routed through the URL (`?chat=<tab>`, see
// use-fullscreen-chat-navigation). It is a Home-tab + session-tab workspace:
//   - a permanent **Home tab** (the launcher): a dashboard grid of session cards, one per
//     home chat thread, with a fixed "+" add-session card last;
//   - **coexisting session tabs**: clicking a card opens that conversation as its own tab to
//     the right of the Home tab, and the tab strip switches between them horizontally.
//
// This is a CONTROLLED component: the active tab is the `fullscreenChatTab` prop (the reserved
// "home"/"pi" anchors or a session thread id, taken from the URL) and tab changes are reported
// up via `onNavigateFullscreenTab`. The open-tab SET stays persisted (as view state) on the
// per-workspace thread registry; only the active-tab selection moved to the URL. Both the cards
// and the conversation draw from the same registry as the compact surface, so the session data
// model is untouched. Closing a tab is a UI-only collapse back to Home, never a thread
// hard-close. The active conversation reuses the SAME HomeAgentConversation as the compact
// sidebar, so a session never tears down when switching presentations.
import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { notifyError } from "@/components/app-toaster";
import { HomeAddSessionCard } from "@/components/home-agent/home-add-session-card";
import { HomeAgentConversation } from "@/components/home-agent/home-agent-conversation";
import { HomeSessionCard } from "@/components/home-agent/home-session-card";
import { PiTabPanel } from "@/components/home-agent/pi-tab-panel";
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
	// The active fullscreen tab, routed through the URL (see use-fullscreen-chat-navigation):
	// the reserved "home" (launcher) / "pi" anchors, or a session thread id. This workspace is
	// a controlled component — it renders the tab named here and asks the parent to change it.
	fullscreenChatTab: string | null;
	/** Navigate to a tab, pushing browser history (user clicks: Home / Pi / a session tab). */
	onNavigateFullscreenTab: (tab: string) => void;
	/** Correct the active tab in place (no history entry) — e.g. a deep link to a closed thread. */
	onReplaceFullscreenTab: (tab: string) => void;
}

export function HomeChatWorkspace({
	currentProjectId,
	runtimeProjectConfig,
	homeThreads,
	taskSessions,
	workspaceGit,
	fullscreenChatTab,
	onNavigateFullscreenTab,
	onReplaceFullscreenTab,
}: HomeChatWorkspaceProps): ReactElement | null {
	// The fixed Pi tab — the native-agent multi-session workspace — is a peer of the Home tab.
	// "home" (or no tab) shows the launcher; "pi" shows the Pi workspace; any other value is the
	// active session tab's thread id.
	const activeTab = fullscreenChatTab ?? "home";
	const piTabActive = activeTab === "pi";
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
	// browser-new-tab idiom), not just the launcher grid. Opening a tab is two moves: add it to
	// the persisted open-tab set (registry) and route the URL to it (so refresh/back restore it).
	const { createThread, openSessionTab } = homeThreads;
	const openAndActivateTab = useCallback(
		(threadId: string) => {
			openSessionTab(threadId);
			onNavigateFullscreenTab(threadId);
		},
		[openSessionTab, onNavigateFullscreenTab],
	);
	const handleCreateSession = useCallback(
		async (input: Parameters<UseHomeThreadsResult["createThread"]>[0]) => {
			const createdThreadId = await createThread(input);
			if (createdThreadId) {
				openAndActivateTab(createdThreadId);
			}
		},
		[createThread, openAndActivateTab],
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

	const { openThreadIds } = homeThreads.fullscreenTabs;
	// The active session tab's thread id (when the active tab is a session, not Home/Pi).
	const activeSessionThreadId = !piTabActive && activeTab !== "home" ? activeTab : null;
	// Threads already open in a session tab get the accent "already open" highlight on
	// their launcher card (mirrors the board task card's selected styling).
	const openThreadIdSet = useMemo(() => new Set(openThreadIds), [openThreadIds]);
	const { threads } = homeThreads;
	const activeTabThread = useMemo(
		() =>
			activeSessionThreadId === null
				? null
				: (threads.find((t) => t.id === activeSessionThreadId) ?? null),
		[activeSessionThreadId, threads],
	);

	// A session tab named in the URL must be in the open-tab set so it shows in the strip
	// (covers deep links + browser-forward to a tab that was not yet opened).
	useEffect(() => {
		if (activeTabThread && !openThreadIdSet.has(activeTabThread.id)) {
			openSessionTab(activeTabThread.id);
		}
	}, [activeTabThread, openThreadIdSet, openSessionTab]);

	// A URL pointing at a session that no longer exists (closed elsewhere, or a stale deep link)
	// falls back to the Home launcher in place rather than rendering an empty conversation.
	useEffect(() => {
		if (activeSessionThreadId !== null && threads.length > 0 && activeTabThread === null) {
			onReplaceFullscreenTab("home");
		}
	}, [activeSessionThreadId, threads.length, activeTabThread, onReplaceFullscreenTab]);

	if (!currentProjectId || !runtimeProjectConfig) {
		return null;
	}

	// Activating Home / a session tab / Pi is a single URL navigation (pushes history).
	const handleActivateHome = () => onNavigateFullscreenTab("home");
	const handleActivateSessionTab = (threadId: string) => onNavigateFullscreenTab(threadId);
	const handleActivatePi = () => onNavigateFullscreenTab("pi");

	// Closing a session tab (UI-only collapse, never a thread hard-close): drop it from the
	// open-tab set, and when it was the active tab, route to the neighbor that slides into its
	// slot (or Home when none remains) — mirroring closeSessionTabOp's neighbor selection.
	const handleCloseSessionTab = (threadId: string) => {
		homeThreads.closeSessionTab(threadId);
		if (activeSessionThreadId !== threadId) {
			return;
		}
		const index = openThreadIds.indexOf(threadId);
		const remaining = openThreadIds.filter((id) => id !== threadId);
		const nextTab = remaining.length === 0 ? "home" : (remaining[Math.min(index, remaining.length - 1)] ?? "home");
		onNavigateFullscreenTab(nextTab);
	};

	// The Home launcher shows when neither the Pi tab nor a session tab is active.
	const showHomeTab = !piTabActive && activeTabThread === null;

	return (
		<div className="flex h-full min-h-0 w-full flex-col gap-2">
			<SessionTabStrip
				threads={homeThreads.threads}
				openThreadIds={openThreadIds}
				activeThreadId={activeTabThread ? activeSessionThreadId : null}
				piTabActive={piTabActive}
				agents={runtimeProjectConfig.agents}
				onActivateHome={handleActivateHome}
				onActivatePi={handleActivatePi}
				onActivateTab={handleActivateSessionTab}
				onCloseTab={handleCloseSessionTab}
			/>

			{piTabActive ? (
				<PiTabPanel
					currentProjectId={currentProjectId}
					runtimeProjectConfig={runtimeProjectConfig}
					homeThreads={homeThreads}
					taskSessions={taskSessions}
					workspaceGit={workspaceGit}
				/>
			) : showHomeTab ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="shrink-0 px-1 pb-3">
						<h2 className="text-sm font-semibold text-text-primary">Sessions</h2>
					</div>
					<div className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto px-1 pb-2">
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
									onOpenSession={openAndActivateTab}
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
