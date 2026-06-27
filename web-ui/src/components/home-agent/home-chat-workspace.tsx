// The fullscreen presentation of the home agent chat.
//
// When the dockable panel is in its `fullscreen` state, the layout selector
// (`selectHomeChatLayout`) mounts this workspace instead of the compact
// thread-bar surface. This is the **Home tab launcher**: a dashboard grid of
// session cards (one per home chat thread) with a permanent "+" add-session card
// fixed last. Both the cards and the create flow draw from the same per-workspace
// thread registry as the compact surface, so the data model is untouched (see the
// "drive the home agent chat layout by panel size" decision).
//
// The coexisting session-tab strip (clicking a card to open its conversation as
// its own tab) is a follow-up task; for now `onOpenSession` makes the clicked
// thread active, which the compact surface reflects on collapse.
import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { HomeAddSessionCard } from "@/components/home-agent/home-add-session-card";
import { HomeSessionCard } from "@/components/home-agent/home-session-card";
import type { UseHomeThreadsResult } from "@/hooks/use-home-threads";
import type { RuntimeConfigResponse, RuntimeTaskSessionSummary } from "@/runtime/types";

interface HomeChatWorkspaceProps {
	currentProjectId: string | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	homeThreads: UseHomeThreadsResult;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
}

export function HomeChatWorkspace({
	currentProjectId,
	runtimeProjectConfig,
	homeThreads,
	taskSessions,
}: HomeChatWorkspaceProps): ReactElement | null {
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

	if (!currentProjectId || !runtimeProjectConfig) {
		return null;
	}

	return (
		<div className="flex h-full min-h-0 w-full flex-col">
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
							onOpenSession={homeThreads.setActiveThread}
						/>
					))}
					<HomeAddSessionCard
						agents={runtimeProjectConfig.agents}
						defaultAgentId={runtimeProjectConfig.selectedAgentId}
						onCreate={homeThreads.createThread}
					/>
				</div>
			</div>
		</div>
	);
}
