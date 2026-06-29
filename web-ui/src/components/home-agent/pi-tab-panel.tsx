// The fullscreen Pi tab body: pi's own multi-session workspace.
//
// A pi-scoped session manager — the left rail lists/switches/creates/closes pi sessions
// while the right side renders the active session's conversation. It reuses the shared
// HomeAgentConversation (only one mounts at a time, so no double chat subscription) and the
// existing thread backend (create/close route to the pi session service). The active-session
// selection is local transient state; the session list itself is persisted via the registry.
// The Pi tab starts empty (no pinned default session) — the user creates the first session.
import { Plus } from "lucide-react";
import { type ReactElement, useCallback, useMemo, useState } from "react";

import { HomeAgentConversation } from "@/components/home-agent/home-agent-conversation";
import { PiSessionRail } from "@/components/home-agent/pi-session-rail";
import {
	derivePiSessions,
	nextActivePiSessionAfterClose,
	PI_AGENT_ID,
	resolveActivePiSessionId,
} from "@/components/home-agent/pi-sessions";
import { Button } from "@/components/ui/button";
import type { UseHomeThreadsResult } from "@/hooks/use-home-threads";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";

interface PiTabPanelProps {
	currentProjectId: string;
	runtimeProjectConfig: RuntimeConfigResponse;
	homeThreads: UseHomeThreadsResult;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
}

export function PiTabPanel({
	currentProjectId,
	runtimeProjectConfig,
	homeThreads,
	taskSessions,
	workspaceGit,
}: PiTabPanelProps): ReactElement {
	const piSessions = useMemo(() => derivePiSessions(homeThreads.threads), [homeThreads.threads]);
	const [requestedActiveId, setRequestedActiveId] = useState<string | null>(null);
	const activeId = resolveActivePiSessionId(piSessions, requestedActiveId);
	const activeSession = useMemo(
		() => (activeId ? (piSessions.find((session) => session.id === activeId) ?? null) : null),
		[piSessions, activeId],
	);

	const { createThread, closeThread, clearNextStep } = homeThreads;
	const handleCreate = useCallback(async () => {
		const created = await createThread({ name: "New session", agentId: PI_AGENT_ID });
		if (created) {
			setRequestedActiveId(created);
		}
	}, [createThread]);
	const handleClose = useCallback(
		async (threadId: string) => {
			setRequestedActiveId((previous) => nextActivePiSessionAfterClose(threadId, previous));
			await closeThread(threadId);
		},
		[closeThread],
	);

	if (!activeSession) {
		return <PiSessionsEmptyState onCreate={() => void handleCreate()} />;
	}

	return (
		<div className="flex min-h-0 flex-1 gap-2">
			<PiSessionRail
				sessions={piSessions}
				activeId={activeId}
				currentProjectId={currentProjectId}
				taskSessions={taskSessions}
				onSelect={setRequestedActiveId}
				onCreate={() => {
					void handleCreate();
				}}
				onClose={handleClose}
			/>
			<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">
				<HomeAgentConversation
					activeThread={activeSession}
					currentProjectId={currentProjectId}
					runtimeProjectConfig={runtimeProjectConfig}
					taskSessions={taskSessions}
					workspaceGit={workspaceGit}
					onClearNextStep={clearNextStep}
				/>
			</div>
		</div>
	);
}

/** Shown when the Pi tab has no sessions yet — the user creates the first one. */
function PiSessionsEmptyState({ onCreate }: { onCreate: () => void }): ReactElement {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
			<p className="text-sm text-text-secondary">No pi sessions yet.</p>
			<Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={onCreate}>
				New session
			</Button>
		</div>
	);
}
