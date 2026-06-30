// Composes the COMPACT (docked/float) sidebar agent surface for the current workspace.
//
// Two stacked surfaces share the SAME state as fullscreen mode:
//   - the **HomeThreadBar** dropdown — the switcher for the synthetic default thread and any
//     non-pi created threads. Pi sessions are filtered out of it (they are owned by the rail);
//   - the **PiSessionManager** — pi's session rail (collapsed by default to a narrow icon strip,
//     since a full rail won't fit a 280px-min sidebar) + the active conversation. A selected pi
//     session shows in the right pane; otherwise the active dropdown thread's conversation shows.
//
// Pi session management lives ONLY in the rail, identically here and in fullscreen — so a pi
// session never migrates into the dropdown when the layout mode flips. This is a real component
// (not a hook returning JSX) so its runtime-stream subscriptions — the kanban session-context
// version (for thread-list refresh) and, inside the conversation, chat tokens — live in its own
// fiber and don't re-render App.
import { DEFAULT_HOME_THREAD_ID } from "@runtime-home-agent-session";
import { type ReactElement, useMemo } from "react";

import { HomeAgentConversation } from "@/components/home-agent/home-agent-conversation";
import { HomeThreadBar } from "@/components/home-agent/home-thread-bar";
import { PiSessionManager } from "@/components/home-agent/pi-session-manager";
import { isPiSession } from "@/components/home-agent/pi-sessions";
import { Spinner } from "@/components/ui/spinner";
import type { UseHomeThreadsResult } from "@/hooks/use-home-threads";
import { useRefreshHomeThreadsOnSessionContextBump } from "@/hooks/use-refresh-home-threads-on-context-bump";
import type {
	RuntimeAgentId,
	RuntimeConfigResponse,
	RuntimeGitRepositoryInfo,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";

interface HomeSidebarAgentPanelProps {
	currentProjectId: string | null;
	hasNoProjects: boolean;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	homeThreads: UseHomeThreadsResult;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
}

export function HomeSidebarAgentPanel({
	currentProjectId,
	hasNoProjects,
	runtimeProjectConfig,
	homeThreads,
	taskSessions,
	workspaceGit,
}: HomeSidebarAgentPanelProps): ReactElement | null {
	// A bump to the kanban session-context version signals session-affecting state changed
	// server-side (e.g. a thread self-titling); re-fetch the registry so the agent-set title
	// replaces the provisional one in the switcher. Subscribing here (a leaf fiber) keeps the
	// refetch out of App's render path.
	useRefreshHomeThreadsOnSessionContextBump(homeThreads.refresh);

	const { threads, activeThreadId, setActiveThread, setActivePiSessionId, createThread } = homeThreads;
	// The dropdown manages the default + non-pi threads only; pi sessions live in the rail.
	const nonPiThreads = useMemo(() => threads.filter((thread) => !isPiSession(thread)), [threads]);
	// The active dropdown thread, resolved within the non-pi list (the shared active id can point
	// at a pi session after a rail create — fall back to the default in that case).
	const activeNonPiThread = useMemo(
		() => nonPiThreads.find((thread) => thread.id === activeThreadId) ?? nonPiThreads[0] ?? null,
		[nonPiThreads, activeThreadId],
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

	// Selecting a dropdown thread (or creating one) clears any active pi-rail selection so the
	// right pane swaps from the pi conversation to that thread (the rail and dropdown both feed
	// the one conversation pane; the dropdown wins on interaction).
	const handleSelectThread = (threadId: string) => {
		setActivePiSessionId(null);
		setActiveThread(threadId);
	};
	const handleCreateThread = (input: { description: string; agentId: RuntimeAgentId }) => {
		setActivePiSessionId(null);
		return createThread(input);
	};

	return (
		<div className="flex h-full w-full min-h-0 flex-col gap-2">
			<div className="flex items-stretch gap-1">
				<div className="min-w-0 flex-1">
					<HomeThreadBar
						threads={nonPiThreads}
						activeThreadId={activeNonPiThread?.id ?? DEFAULT_HOME_THREAD_ID}
						agents={runtimeProjectConfig.agents}
						defaultAgentId={runtimeProjectConfig.selectedAgentId}
						currentProjectId={currentProjectId}
						taskSessions={taskSessions}
						onSelectThread={handleSelectThread}
						onCreateThread={handleCreateThread}
						onRenameThread={homeThreads.renameThread}
						onCloseThread={homeThreads.closeThread}
					/>
				</div>
			</div>
			<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">
				<PiSessionManager
					currentProjectId={currentProjectId}
					runtimeProjectConfig={runtimeProjectConfig}
					homeThreads={homeThreads}
					taskSessions={taskSessions}
					workspaceGit={workspaceGit}
					collapsible
					defaultCollapsed
					fallback={
						<HomeAgentConversation
							activeThread={activeNonPiThread}
							currentProjectId={currentProjectId}
							runtimeProjectConfig={runtimeProjectConfig}
							taskSessions={taskSessions}
							workspaceGit={workspaceGit}
							onClearNextStep={homeThreads.clearNextStep}
						/>
					}
				/>
			</div>
		</div>
	);
}
