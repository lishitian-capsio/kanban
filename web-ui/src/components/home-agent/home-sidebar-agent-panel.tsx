// Composes the COMPACT sidebar agent surface for the current workspace.
//
// It renders the multi-thread switcher (HomeThreadBar) plus the conversation for the
// active thread (HomeAgentConversation). Threads run in parallel, so switching never
// tears down another thread's session. This is the compact (docked/float) presentation;
// the fullscreen Home-tab/session-tab presentation is HomeChatWorkspace, which reuses the
// same HomeAgentConversation for the active tab (decision 1902b).
//
// This is a real component (not a hook returning JSX) so its runtime-stream subscriptions
// — the kanban session-context version (for thread-list refresh) and, inside the
// conversation, chat tokens — live in its own fiber and don't re-render App.
import type { ReactElement } from "react";
import { useState } from "react";

import { HomeAgentConversation } from "@/components/home-agent/home-agent-conversation";
import { HomeThreadBar } from "@/components/home-agent/home-thread-bar";
import type { SessionTaskDialogActions } from "@/components/home-agent/thread-tasks";
import { PiConversationSurface } from "@/components/home-agent/pi-conversation-surface";
import { getActiveHighlightClass } from "@/components/home-agent/session-active-highlight";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { UseHomeThreadsResult } from "@/hooks/use-home-threads";
import { useRefreshHomeThreadsOnSessionContextBump } from "@/hooks/use-refresh-home-threads-on-context-bump";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";

type DockedSide = "pi" | "sessions";

interface HomeSidebarAgentPanelProps {
	currentProjectId: string | null;
	hasNoProjects: boolean;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	homeThreads: UseHomeThreadsResult;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	threadTaskActions: SessionTaskDialogActions;
}

export function HomeSidebarAgentPanel({
	currentProjectId,
	hasNoProjects,
	runtimeProjectConfig,
	homeThreads,
	taskSessions,
	workspaceGit,
	threadTaskActions,
}: HomeSidebarAgentPanelProps): ReactElement | null {
	// A bump to the kanban session-context version signals session-affecting state changed
	// server-side (e.g. a thread self-titling); re-fetch the registry so the agent-set title
	// replaces the provisional one in the switcher. Subscribing here (a leaf fiber) keeps the
	// refetch out of App's render path.
	useRefreshHomeThreadsOnSessionContextBump(homeThreads.refresh);

	// Pi is its own dedicated area (decision 647ea / X1), separated from the CLI-agent thread
	// switcher. The docked sidebar reaches it via a top toggle; "Sessions" is the CLI thread bar
	// (which never lists Pi). Default to Pi — it is the native, always-present agent.
	const [dockedSide, setDockedSide] = useState<DockedSide>("pi");

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

	return (
		<div className="flex h-full w-full min-h-0 flex-col gap-2">
			<div className="flex shrink-0 items-stretch gap-1" role="tablist" aria-label="Home agent surface">
				{(["pi", "sessions"] as const).map((side) => (
					<button
						key={side}
						type="button"
						role="tab"
						aria-selected={dockedSide === side}
						onClick={() => setDockedSide(side)}
						className={cn(
							"rounded-md px-3 py-1 text-[13px] font-medium",
							getActiveHighlightClass("tab", dockedSide === side),
						)}
					>
						{side === "pi" ? "Pi" : "Sessions"}
					</button>
				))}
			</div>
			{dockedSide === "pi" ? (
				<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">
					<PiConversationSurface
						currentProjectId={currentProjectId}
						runtimeProjectConfig={runtimeProjectConfig}
						workspaceGit={workspaceGit}
						orientation="docked"
					/>
				</div>
			) : (
				<>
					<div className="flex items-stretch gap-1">
						<div className="min-w-0 flex-1">
							<HomeThreadBar
								threads={homeThreads.threads}
								activeThreadId={homeThreads.activeThreadId}
								agents={runtimeProjectConfig.agents}
								defaultAgentId={runtimeProjectConfig.selectedAgentId}
								currentProjectId={currentProjectId}
								taskSessions={taskSessions}
								onSelectThread={homeThreads.setActiveThread}
								onCreateThread={homeThreads.createThread}
								onRenameThread={homeThreads.renameThread}
								onCloseThread={homeThreads.closeThread}
							/>
						</div>
					</div>
					<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">
						<HomeAgentConversation
							activeThread={homeThreads.activeThread}
							currentProjectId={currentProjectId}
							runtimeProjectConfig={runtimeProjectConfig}
							taskSessions={taskSessions}
							workspaceGit={workspaceGit}
							threadTaskActions={threadTaskActions}
							onClearNextStep={homeThreads.clearNextStep}
						/>
					</div>
				</>
			)}
		</div>
	);
}
