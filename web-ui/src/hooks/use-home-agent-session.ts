// Manages the synthetic home agent session lifecycle for the sidebar.
//
// The home sidebar can host several parallel chat threads (see use-home-threads).
// This hook drives the *active* thread: it derives the thread's synthetic task id
// and panel mode (pi → native chat, other → terminal), lazily starts the active
// terminal session, and reloads the active pi session when the runtime bumps the
// Kanban session context version.
//
// Parallel-session rules:
//   - Switching the active thread does NOT stop the previous thread's session —
//     background threads keep running and are reattached on switch-back.
//   - Only the *default* thread rotates: when the workspace-global agent changes,
//     the default thread's session identity changes and the previous default
//     session is stopped (preserving the historical single-home-chat behavior).
//   - Closing a thread stops its session server-side (HomeThreadStore.onCloseSession).

import { createHomeAgentSessionId, DEFAULT_HOME_THREAD_ID } from "@runtime-home-agent-session";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useRef } from "react";

import { notifyError } from "@/components/app-toaster";
import { useReloadPiSessionOnContextBump } from "@/hooks/use-reload-pi-session-on-context-bump";
import { isNativeAgentSelected } from "@/runtime/native-agent";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentId,
	RuntimeConfigResponse,
	RuntimeGitRepositoryInfo,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";

type HomeAgentPanelMode = "chat" | "terminal";

export interface HomeAgentActiveThread {
	id: string;
	agentId: RuntimeAgentId;
}

interface UseHomeAgentSessionInput {
	currentProjectId: string | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	activeThread: HomeAgentActiveThread | null;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	kanbanSessionContextVersion: number;
	sessionSummaries: Record<string, RuntimeTaskSessionSummary>;
	setSessionSummaries: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	upsertSessionSummary: (summary: RuntimeTaskSessionSummary) => void;
}

interface UseHomeAgentSessionResult {
	panelMode: HomeAgentPanelMode | null;
	taskId: string | null;
}

interface HomeAgentSessionIdentity {
	workspaceId: string;
	taskId: string;
}

function resolveHomeAgentBaseRef(workspaceGit: RuntimeGitRepositoryInfo | null): string {
	return workspaceGit?.currentBranch ?? workspaceGit?.defaultBranch ?? "HEAD";
}

function buildHomeAgentSessionKey(session: HomeAgentSessionIdentity): string {
	return `${session.workspaceId}:${session.taskId}`;
}

async function stopHomeAgentSession(session: HomeAgentSessionIdentity | null): Promise<void> {
	if (!session) {
		return;
	}
	try {
		await getRuntimeTrpcClient(session.workspaceId).runtime.stopTaskSession.mutate({
			taskId: session.taskId,
		});
	} catch {
		// Ignore stop errors during cleanup.
	}
}

export function useHomeAgentSession({
	currentProjectId,
	runtimeProjectConfig,
	activeThread,
	workspaceGit,
	kanbanSessionContextVersion,
	sessionSummaries,
	setSessionSummaries,
	upsertSessionSummary,
}: UseHomeAgentSessionInput): UseHomeAgentSessionResult {
	const latestBaseRefRef = useRef("HEAD");
	const startedSessionKeysRef = useRef(new Set<string>());
	const failedSessionKeysRef = useRef(new Set<string>());
	const pendingStartRequestIdsRef = useRef(new Map<string, number>());
	const lastDefaultTaskIdByWorkspaceRef = useRef(new Map<string, string>());
	const nextStartRequestIdRef = useRef(0);
	const disposedRef = useRef(false);

	useEffect(() => {
		latestBaseRefRef.current = resolveHomeAgentBaseRef(workspaceGit);
	}, [workspaceGit?.currentBranch, workspaceGit?.defaultBranch]);

	const { panelMode, taskId } = useMemo<{ panelMode: HomeAgentPanelMode | null; taskId: string | null }>(() => {
		if (!currentProjectId || !runtimeProjectConfig || !activeThread) {
			return { panelMode: null, taskId: null };
		}
		const nextTaskId = createHomeAgentSessionId(currentProjectId, activeThread.agentId, activeThread.id);
		if (isNativeAgentSelected(activeThread.agentId)) {
			return { panelMode: "chat", taskId: nextTaskId };
		}
		// Terminal agent. The default thread mirrors the workspace-global agent, so
		// fall back to the historical "configure an agent" message when no runnable
		// command is resolved. Explicitly created threads pick a launch-supported
		// agent, so render the terminal and let the backend surface launch errors.
		if (activeThread.id === DEFAULT_HOME_THREAD_ID && !runtimeProjectConfig.effectiveCommand) {
			return { panelMode: null, taskId: nextTaskId };
		}
		return { panelMode: "terminal", taskId: nextTaskId };
	}, [currentProjectId, runtimeProjectConfig, activeThread]);

	// Rotate the default thread: when the workspace-global agent changes, the
	// default thread's session identity changes. Stop the previous default session
	// and drop its cached summary so it does not linger as an orphan.
	//
	// Pi is deliberately excluded (decision 647ea / X1): Pi is its own always-present
	// area (PiConversationSurface), not the default thread, so a Pi global-agent
	// selection must NOT be tracked here — otherwise switching the global agent away
	// from Pi would stop the persistent Pi area session.
	const defaultThreadTaskId =
		currentProjectId && runtimeProjectConfig && !isNativeAgentSelected(runtimeProjectConfig.selectedAgentId)
			? createHomeAgentSessionId(currentProjectId, runtimeProjectConfig.selectedAgentId, DEFAULT_HOME_THREAD_ID)
			: null;
	useEffect(() => {
		if (!currentProjectId || !defaultThreadTaskId) {
			return;
		}
		const previousDefaultTaskId = lastDefaultTaskIdByWorkspaceRef.current.get(currentProjectId) ?? null;
		if (previousDefaultTaskId === defaultThreadTaskId) {
			return;
		}
		lastDefaultTaskIdByWorkspaceRef.current.set(currentProjectId, defaultThreadTaskId);
		if (!previousDefaultTaskId) {
			return;
		}
		const previousSessionKey = buildHomeAgentSessionKey({
			workspaceId: currentProjectId,
			taskId: previousDefaultTaskId,
		});
		startedSessionKeysRef.current.delete(previousSessionKey);
		failedSessionKeysRef.current.delete(previousSessionKey);
		// Drop any in-flight start for the rotated-away session so its late
		// resolution can't re-add an orphaned summary or mark it started.
		pendingStartRequestIdsRef.current.delete(previousSessionKey);
		setSessionSummaries((current) => {
			if (!(previousDefaultTaskId in current)) {
				return current;
			}
			const next = { ...current };
			delete next[previousDefaultTaskId];
			return next;
		});
		void stopHomeAgentSession({ workspaceId: currentProjectId, taskId: previousDefaultTaskId });
	}, [currentProjectId, defaultThreadTaskId, setSessionSummaries]);

	// When MCP settings or auth change, the runtime bumps the Kanban session context
	// version; reload the active pi chat in place. Pi normally lives in its own area
	// (PiConversationSurface, which runs the same hook), so `active` here is only true
	// in the defensive case where a pi thread somehow reaches this CLI-focused hook.
	useReloadPiSessionOnContextBump({
		workspaceId: currentProjectId,
		taskId,
		active: panelMode === "chat",
		hasSession: !!(taskId && sessionSummaries[taskId]),
		kanbanSessionContextVersion,
		onSummary: upsertSessionSummary,
	});

	// Lazily start the active terminal thread's session. Background terminal
	// threads keep running, so a started session is never stopped on switch — the
	// AgentTerminalPanel reattaches to it. Pi chats start lazily on first message.
	useEffect(() => {
		if (!currentProjectId || panelMode !== "terminal" || !taskId) {
			return;
		}

		const session: HomeAgentSessionIdentity = { workspaceId: currentProjectId, taskId };
		const sessionKey = buildHomeAgentSessionKey(session);

		if (
			startedSessionKeysRef.current.has(sessionKey) ||
			failedSessionKeysRef.current.has(sessionKey) ||
			pendingStartRequestIdsRef.current.has(sessionKey)
		) {
			return;
		}

		const requestId = nextStartRequestIdRef.current + 1;
		nextStartRequestIdRef.current = requestId;
		pendingStartRequestIdsRef.current.set(sessionKey, requestId);

		void (async () => {
			try {
				const geometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);
				const response = await getRuntimeTrpcClient(session.workspaceId).runtime.startTaskSession.mutate({
					taskId: session.taskId,
					prompt: "",
					baseRef: latestBaseRefRef.current,
					cols: geometry.cols,
					rows: geometry.rows,
				});

				if (pendingStartRequestIdsRef.current.get(sessionKey) !== requestId) {
					return;
				}
				pendingStartRequestIdsRef.current.delete(sessionKey);

				if (!response.ok || !response.summary) {
					throw new Error(response.error ?? "Could not start home agent session.");
				}

				if (disposedRef.current) {
					return;
				}

				startedSessionKeysRef.current.add(sessionKey);
				upsertSessionSummary(response.summary);
			} catch (error) {
				if (pendingStartRequestIdsRef.current.get(sessionKey) !== requestId) {
					return;
				}
				pendingStartRequestIdsRef.current.delete(sessionKey);
				failedSessionKeysRef.current.add(sessionKey);

				const message = error instanceof Error ? error.message : String(error);
				// Upsert a failed summary so the UI transitions out of the loading
				// state and can surface the error inline instead of only a toast.
				upsertSessionSummary({
					taskId: session.taskId,
					state: "failed",
					agentId: null,
					workspacePath: null,
					pid: null,
					startedAt: null,
					updatedAt: Date.now(),
					lastOutputAt: null,
					reviewReason: "error",
					exitCode: null,
					lastHookAt: null,
					latestHookActivity: null,
					warningMessage: message,
				});

				if (disposedRef.current) {
					return;
				}
				notifyError(message);
			}
		})();
	}, [currentProjectId, panelMode, taskId, upsertSessionSummary]);

	useEffect(() => {
		return () => {
			disposedRef.current = true;
			startedSessionKeysRef.current.clear();
			failedSessionKeysRef.current.clear();
			pendingStartRequestIdsRef.current.clear();
			lastDefaultTaskIdByWorkspaceRef.current.clear();
		};
	}, []);

	return { panelMode, taskId };
}
