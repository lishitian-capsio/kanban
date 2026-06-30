// Pi's session workspace: the one place pi sessions are created / switched / renamed / closed,
// mounted identically in board (docked) mode and session (fullscreen) mode.
//
// Layout is a permanent two-pane column — the PiSessionRail on the left, a single conversation
// on the right — NOT a tab. The active pi session comes from the shared `homeThreads`
// selection (`activePiSessionId`), so it never drifts between modes. When no pi session is
// selected, the right pane shows `fallback`: the surrounding non-pi surface (the board
// dropdown's thread conversation, or the fullscreen Home launcher / non-pi session conversation).
// A selected pi session takes precedence over that fallback.
//
// Only ONE HomeAgentConversation mounts at a time (active pi session OR the fallback's own
// conversation), so there is never a double chat-token subscription — the granular-store leaf
// rule holds. Active-session selection lives in `useHomeThreads` (shared, survives mode
// switches); the session list itself is the persisted registry.
import { type ReactElement, type ReactNode, useCallback, useMemo, useState } from "react";

import { HomeAgentConversation } from "@/components/home-agent/home-agent-conversation";
import { PiSessionRail } from "@/components/home-agent/pi-session-rail";
import { derivePiSessions, nextActivePiSessionAfterClose, PI_AGENT_ID } from "@/components/home-agent/pi-sessions";
import type { UseHomeThreadsResult } from "@/hooks/use-home-threads";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";

interface PiSessionManagerProps {
	currentProjectId: string;
	runtimeProjectConfig: RuntimeConfigResponse;
	homeThreads: UseHomeThreadsResult;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	/** Allow the rail to collapse to a narrow icon strip (the docked-sidebar affordance). */
	collapsible?: boolean;
	/** Initial collapsed state when `collapsible` (the docked sidebar opens collapsed). */
	defaultCollapsed?: boolean;
	/**
	 * Always-rendered top of the right pane, ABOVE the swappable body — the fullscreen tab strip
	 * goes here so it stays visible whether a pi session or the fallback is showing. Board mode
	 * passes nothing (its non-pi switcher is the dropdown above this whole component).
	 */
	header?: ReactNode;
	/** Right-pane body shown when no pi session is selected (the non-pi surface). */
	fallback: ReactNode;
}

export function PiSessionManager({
	currentProjectId,
	runtimeProjectConfig,
	homeThreads,
	taskSessions,
	workspaceGit,
	collapsible = false,
	defaultCollapsed = false,
	header,
	fallback,
}: PiSessionManagerProps): ReactElement {
	const piSessions = useMemo(() => derivePiSessions(homeThreads.threads), [homeThreads.threads]);
	const { activePiSessionId, setActivePiSessionId, createThread, closeThread, renameThread, clearNextStep } =
		homeThreads;
	const activeSession = useMemo(
		() => piSessions.find((session) => session.id === activePiSessionId) ?? null,
		[piSessions, activePiSessionId],
	);

	const [collapsed, setCollapsed] = useState(defaultCollapsed);

	const handleCreate = useCallback(async () => {
		const created = await createThread({ name: "New session", agentId: PI_AGENT_ID });
		if (created) {
			setActivePiSessionId(created);
		}
	}, [createThread, setActivePiSessionId]);

	const handleClose = useCallback(
		async (threadId: string) => {
			setActivePiSessionId(nextActivePiSessionAfterClose(threadId, activePiSessionId));
			await closeThread(threadId);
		},
		[closeThread, setActivePiSessionId, activePiSessionId],
	);

	return (
		<div className="flex h-full min-h-0 w-full flex-1 gap-2">
			<PiSessionRail
				sessions={piSessions}
				activeId={activePiSessionId}
				currentProjectId={currentProjectId}
				agents={runtimeProjectConfig.agents}
				taskSessions={taskSessions}
				onSelect={setActivePiSessionId}
				onCreate={() => {
					void handleCreate();
				}}
				onClose={handleClose}
				onRename={renameThread}
				collapsible={collapsible}
				collapsed={collapsed}
				onToggleCollapsed={() => setCollapsed((value) => !value)}
			/>
			<div className="flex min-h-0 flex-1 flex-col gap-2">
				{header}
				<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">
					{activeSession ? (
						<HomeAgentConversation
							activeThread={activeSession}
							currentProjectId={currentProjectId}
							runtimeProjectConfig={runtimeProjectConfig}
							taskSessions={taskSessions}
							workspaceGit={workspaceGit}
							onClearNextStep={clearNextStep}
						/>
					) : (
						fallback
					)}
				</div>
			</div>
		</div>
	);
}
