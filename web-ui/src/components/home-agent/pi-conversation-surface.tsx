// The single embedded Pi conversation area (decision 647ea / X1).
//
// Pi is NOT modeled like a CLI agent (one process = one switchable session). It runs
// in-process as exactly one agent per workspace, so it gets ONE dedicated area — a header
// (agent + provider), one transcript, a composer, and a subagents rail — rather than a
// switchable multi-session rail. This same component is mounted in BOTH the docked sidebar
// and the fullscreen Pi tab, bound to the STABLE per-workspace Pi session id
// (`createHomeAgentSessionId(ws, "pi")`, the legacy 3-segment id), so the conversation never
// drifts or tears down when toggling modes — that is the structural fix for the old
// mode-drift bug.
//
// Pi's concurrency lives in the subagents rail: selecting a subagent swaps the ONE active
// transcript subscription to that subagent's composite session id (drill-in is read-only —
// subagents are spawn-and-forget child runs). All runtime-store subscriptions live in this
// leaf fiber so streaming tokens re-render only this surface.
import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { SessionProviderControl } from "@/components/agent-providers/session-provider-control";
import { KanbanAgentChatPanel } from "@/components/detail-panels/kanban-agent-chat-panel";
import { AgentAvatar, resolveAgentLabel } from "@/components/home-agent/agent-icon";
import { SubagentsRail } from "@/components/home-agent/subagents-rail";
import { createIdleTaskSession } from "@/hooks/app-utils";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import { useKanbanChatRuntimeActions } from "@/hooks/use-kanban-chat-runtime-actions";
import { useReloadPiSessionOnContextBump } from "@/hooks/use-reload-pi-session-on-context-bump";
import {
	useLatestTaskChatMessageForTask,
	useRuntimeKanbanSessionContextVersion,
	useTaskChatMessages,
	useTaskSessionSummary,
} from "@/runtime/runtime-stream-store";
import type {
	RuntimeConfigResponse,
	RuntimeGitRepositoryInfo,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskSubagent,
	RuntimeTaskSubagentStatus,
} from "@/runtime/types";

const PI_AGENT_ID = "pi" as const;

interface PiConversationSurfaceProps {
	currentProjectId: string;
	runtimeProjectConfig: RuntimeConfigResponse;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	/** Docked → rail as a strip below; fullscreen → rail as a right column. */
	orientation: "docked" | "fullscreen";
}

function subagentStatusToSessionState(status: RuntimeTaskSubagentStatus): RuntimeTaskSessionState {
	switch (status) {
		case "running":
			return "running";
		case "done":
			return "awaiting_review";
		case "failed":
			return "failed";
		default:
			return "idle";
	}
}

/** A read-only summary synthesized from a subagent record, for the drill-in transcript header. */
function toSubagentSummary(subagent: RuntimeTaskSubagent): RuntimeTaskSessionSummary {
	return {
		...createIdleTaskSession(subagent.sessionId),
		state: subagentStatusToSessionState(subagent.status),
		agentId: PI_AGENT_ID,
		modelId: subagent.modelId ?? null,
		usage: subagent.usage ?? null,
		startedAt: subagent.startedAt,
		updatedAt: subagent.updatedAt,
	};
}

export function PiConversationSurface({
	currentProjectId,
	runtimeProjectConfig,
	orientation,
}: PiConversationSurfaceProps): ReactElement {
	const parentTaskId = useMemo(() => createHomeAgentSessionId(currentProjectId, PI_AGENT_ID), [currentProjectId]);

	const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
	// Optimistic parent summary from send/reload results, merged with the broadcast store.
	const [localParentSummary, setLocalParentSummary] = useState<RuntimeTaskSessionSummary | null>(null);
	const [providerOverride, setProviderOverride] = useState<string | null>(null);

	const kanbanSessionContextVersion = useRuntimeKanbanSessionContextVersion();
	const storeParentSummary = useTaskSessionSummary(parentTaskId);
	const parentSummary = useMemo(
		() => selectNewestTaskSessionSummary(storeParentSummary, localParentSummary),
		[storeParentSummary, localParentSummary],
	);

	const subagents = parentSummary?.subagents ?? null;
	// Resolve the selected subagent; if it vanished (list changed), fall back to main.
	const selectedSubagent = useMemo(
		() => (selectedSubagentId ? (subagents?.find((s) => s.subagentId === selectedSubagentId) ?? null) : null),
		[selectedSubagentId, subagents],
	);
	const activeTaskId = selectedSubagent ? selectedSubagent.sessionId : parentTaskId;
	const isSubagentView = selectedSubagent !== null;

	const activeChatMessages = useTaskChatMessages(activeTaskId);
	const latestActiveChatMessage = useLatestTaskChatMessageForTask(activeTaskId);

	const upsertParentSummary = useCallback((summary: RuntimeTaskSessionSummary) => {
		if (summary.taskId !== undefined) {
			setLocalParentSummary((previous) => selectNewestTaskSessionSummary(previous, summary));
		}
	}, []);

	const { sendTaskChatMessage, loadTaskChatMessages, cancelTaskChatTurn } = useKanbanChatRuntimeActions({
		currentProjectId,
		onSessionSummary: upsertParentSummary,
	});

	useReloadPiSessionOnContextBump({
		workspaceId: currentProjectId,
		taskId: parentTaskId,
		active: true,
		hasSession: parentSummary !== null,
		kanbanSessionContextVersion,
		onSummary: upsertParentSummary,
	});

	const selectedAgentLabel = useMemo(
		() => resolveAgentLabel(runtimeProjectConfig.agents, PI_AGENT_ID),
		[runtimeProjectConfig],
	);

	const handleSendMessage = useCallback(
		async (messageTaskId: string, text: string, options?: { mode?: "act" | "plan" }) => {
			return await sendTaskChatMessage(messageTaskId, text, {
				...options,
				...(providerOverride ? { providerId: providerOverride } : {}),
			});
		},
		[providerOverride, sendTaskChatMessage],
	);

	const handleLoadMessages = useCallback(
		async (messageTaskId: string) => await loadTaskChatMessages(messageTaskId),
		[loadTaskChatMessages],
	);
	const handleCancelTurn = useCallback(
		async (messageTaskId: string) => await cancelTaskChatTurn(messageTaskId),
		[cancelTaskChatTurn],
	);

	const activeSummary: RuntimeTaskSessionSummary = selectedSubagent
		? toSubagentSummary(selectedSubagent)
		: (parentSummary ?? createIdleTaskSession(parentTaskId));

	const modelControlSlot = isSubagentView ? null : (
		<div className="flex min-w-0 items-center gap-2">
			<span className="flex min-w-0 shrink items-center gap-1.5 text-[13px]">
				<AgentAvatar agents={runtimeProjectConfig.agents} agentId={PI_AGENT_ID} size="sm" />
				<span className="min-w-0 truncate font-medium text-text-primary">{selectedAgentLabel}</span>
			</span>
			<SessionProviderControl
				workspaceId={currentProjectId}
				agentId={PI_AGENT_ID}
				selectedProviderId={providerOverride}
				onSelectProvider={setProviderOverride}
			/>
		</div>
	);

	const isFullscreen = orientation === "fullscreen";

	return (
		<div className={isFullscreen ? "flex h-full min-h-0 w-full gap-2" : "flex h-full min-h-0 w-full flex-col gap-2"}>
			<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">
				<KanbanAgentChatPanel
					key={activeTaskId}
					taskId={activeTaskId}
					summary={activeSummary}
					defaultMode="act"
					showComposerModeToggle={false}
					readOnly={isSubagentView}
					workspaceId={currentProjectId}
					runtimeConfig={runtimeProjectConfig}
					modelControlSlot={modelControlSlot}
					onSendMessage={handleSendMessage}
					onCancelTurn={handleCancelTurn}
					onLoadMessages={handleLoadMessages}
					incomingMessage={latestActiveChatMessage}
					incomingMessages={activeChatMessages}
					composerPlaceholder="Ask Kanban to add, edit, start, or link tasks"
				/>
			</div>
			<SubagentsRail
				agents={runtimeProjectConfig.agents}
				mainSummary={parentSummary}
				subagents={subagents}
				selectedSubagentId={selectedSubagent ? selectedSubagentId : null}
				onSelect={setSelectedSubagentId}
				orientation={orientation}
			/>
		</div>
	);
}
