// Streams live runtime state to browser clients over websocket.
// It listens to terminal and native kanban updates, normalizes them into the
// shared API contract, and fans out workspace-scoped snapshots and deltas.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { PiTaskSessionService } from "../agent-sdk/kanban/pi-task-session-service";
import type {
	RuntimeBoardSyncStatus,
	RuntimeKanbanMcpServerAuthStatus,
	RuntimeOpsMetrics,
	RuntimeStateStreamBoardSyncStatusMessage,
	RuntimeStateStreamErrorMessage,
	RuntimeStateStreamKanbanSessionContextUpdatedMessage,
	RuntimeStateStreamMcpAuthUpdatedMessage,
	RuntimeStateStreamMessage,
	RuntimeStateStreamOpsMetricsMessage,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskChatClearedMessage,
	RuntimeStateStreamTaskChatMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeStateStreamTaskSessionsMessage,
	RuntimeStateStreamWorkspaceMetadataMessage,
	RuntimeStateStreamWorkspaceStateMessage,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import type { SessionMessage } from "../session/session-message";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { markStall } from "./event-loop-stall-watchdog";
import { createTaskChatMessageBatcher } from "./task-chat-message-batcher";
import { createWorkspaceMetadataMonitor } from "./workspace-metadata-monitor";
import type { ResolvedWorkspaceStreamTarget, WorkspaceRegistry } from "./workspace-registry";

const TASK_SESSION_STREAM_BATCH_MS = 150;
/**
 * Debounce window for streaming `task_chat_message` broadcasts. Short enough to
 * keep token rendering feeling live, long enough to collapse a per-token burst
 * (which re-sends the whole accumulated message) into one send per window.
 */
const CHAT_MESSAGE_STREAM_BATCH_MS = 50;

export interface DisposeRuntimeStateWorkspaceOptions {
	disconnectClients?: boolean;
	closeClientErrorMessage?: string;
}

export interface CreateRuntimeStateHubDependencies {
	workspaceRegistry: Pick<
		WorkspaceRegistry,
		| "resolveWorkspaceForStream"
		| "buildProjectsPayload"
		| "buildProjectsPayloadFast"
		| "buildWorkspaceStateSnapshot"
		| "refreshProjectTaskCountsIfChanged"
	>;
	/**
	 * Optional observer of session-summary transitions, fired for BOTH terminal (CLI) and pi
	 * agents from the same seam the hub already uses to broadcast summaries. Carries the prior
	 * and current summary so the observer can classify the transition itself (e.g. the IM task
	 * notifier). Called synchronously and fire-and-forget; a throwing observer is swallowed so it
	 * can never break state broadcasts. `previous` is null on the first observation of a task.
	 */
	onTaskSessionTransition?: (event: {
		workspaceId: string;
		previous: RuntimeTaskSessionSummary | null;
		next: RuntimeTaskSessionSummary;
	}) => void;
	/**
	 * Optional observer of transcript messages, fired for BOTH terminal (CLI) and pi agents from
	 * the same `onMessage` seam that feeds the `task_chat_message` broadcast — but UNLIKE the
	 * broadcast it fires regardless of connected web clients, so an IM-driven session with no
	 * browser open is still observed (e.g. the IM chat reply notifier buffering assistant text).
	 * Called synchronously and fire-and-forget; a throwing observer is swallowed.
	 */
	onTaskChatMessage?: (workspaceId: string, taskId: string, message: SessionMessage) => void;
}

export interface RuntimeStateHub {
	trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => void;
	trackPiTaskSessionService: (workspaceId: string, workspacePath: string, service: PiTaskSessionService) => void;
	broadcastTaskChatMessage: (workspaceId: string, taskId: string, message: SessionMessage) => void;
	broadcastTaskChatCleared: (workspaceId: string, taskId: string) => void;
	handleUpgrade: (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: {
			requestedWorkspaceId: string | null;
		},
	) => void;
	disposeWorkspace: (workspaceId: string, options?: DisposeRuntimeStateWorkspaceOptions) => void;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void>;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void>;
	broadcastKanbanMcpAuthStatusesUpdated: (statuses: RuntimeKanbanMcpServerAuthStatus[]) => void;
	bumpKanbanSessionContextVersion: () => void;
	broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
	broadcastBoardSyncStatusUpdated: (workspaceId: string, status: RuntimeBoardSyncStatus) => void;
	/**
	 * Fan out a runtime ops metrics snapshot. Process-global (not workspace-scoped),
	 * so it goes to every connected runtime client regardless of which workspace
	 * they are viewing.
	 */
	broadcastRuntimeOpsMetrics: (metrics: RuntimeOpsMetrics) => void;
	close: () => Promise<void>;
}

export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies): RuntimeStateHub {
	const terminalSummaryUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const terminalMessageUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const piSummaryUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const piMessageUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const piPreviousSummaryByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	// Terminal agents have no snapshot-replay use for prior summaries (unlike pi), but the IM task
	// notifier needs prev→next transitions for CLI agents too, so we track them here in parallel.
	const terminalPreviousSummaryByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	const pendingTaskSessionSummariesByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	const taskSessionBroadcastTimersByWorkspaceId = new Map<string, NodeJS.Timeout>();
	const runtimeStateClientsByWorkspaceId = new Map<string, Set<WebSocket>>();
	const runtimeStateClients = new Set<WebSocket>();
	const runtimeStateWorkspaceIdByClient = new Map<WebSocket, string>();
	let kanbanSessionContextVersion = 0;
	const runtimeStateWebSocketServer = new WebSocketServer({ noServer: true });
	const workspaceMetadataMonitor = createWorkspaceMetadataMonitor({
		onMetadataUpdated: (workspaceId, workspaceMetadata) => {
			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (!clients || clients.size === 0) {
				return;
			}
			const payload: RuntimeStateStreamWorkspaceMetadataMessage = {
				type: "workspace_metadata_updated",
				workspaceId,
				workspaceMetadata,
			};
			for (const client of clients) {
				sendRuntimeStateMessage(client, payload);
			}
		},
	});

	const sendRuntimeStateMessage = (client: WebSocket, payload: RuntimeStateStreamMessage) => {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			client.send(JSON.stringify(payload));
		} catch {
			// Ignore websocket write errors; close handlers clean up disconnected sockets.
		}
	};

	const emitTaskSessionTransition = (
		workspaceId: string,
		previous: RuntimeTaskSessionSummary | null,
		next: RuntimeTaskSessionSummary,
	) => {
		if (!deps.onTaskSessionTransition) {
			return;
		}
		try {
			deps.onTaskSessionTransition({ workspaceId, previous, next });
		} catch {
			// A transition observer (e.g. IM notifier) must never break state broadcasts.
		}
	};

	const emitTaskChatMessage = (workspaceId: string, taskId: string, message: SessionMessage) => {
		if (!deps.onTaskChatMessage) {
			return;
		}
		try {
			deps.onTaskChatMessage(workspaceId, taskId, message);
		} catch {
			// A message observer (e.g. IM reply notifier) must never break message broadcasts.
		}
	};

	const broadcastRuntimeProjectsUpdated = async (preferredCurrentProjectId: string | null): Promise<void> => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		try {
			// Breadcrumb for the stall watchdog. `notifyStateUpdated` only `void`-fires
			// this (and the workspace-state broadcast, which early-returns before its own
			// mark when the workspace has no clients), so without a mark here a stall in
			// the projects-payload fan-out is mis-attributed to the stale "trpc
			// workspace.notifyStateUpdated" request breadcrumb. buildProjectsPayload marks
			// the per-project sub-steps from here on.
			markStall("broadcast:projects");
			const payload = await deps.workspaceRegistry.buildProjectsPayload(preferredCurrentProjectId);
			for (const client of runtimeStateClients) {
				sendRuntimeStateMessage(client, {
					type: "projects_updated",
					currentProjectId: payload.currentProjectId,
					projects: payload.projects,
				} satisfies RuntimeStateStreamProjectsMessage);
			}
		} catch {
			// Ignore transient project summary failures; next update will resync.
		}
	};

	const broadcastKanbanMcpAuthStatusesUpdated = (statuses: RuntimeKanbanMcpServerAuthStatus[]) => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamMcpAuthUpdatedMessage = {
			type: "mcp_auth_updated",
			statuses,
		};
		for (const client of runtimeStateClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const bumpKanbanSessionContextVersion = () => {
		kanbanSessionContextVersion += 1;
		if (runtimeStateClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamKanbanSessionContextUpdatedMessage = {
			type: "kanban_session_context_updated",
			version: kanbanSessionContextVersion,
		};
		for (const client of runtimeStateClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const flushTaskSessionSummaries = (workspaceId: string) => {
		const pending = pendingTaskSessionSummariesByWorkspaceId.get(workspaceId);
		if (!pending || pending.size === 0) {
			return;
		}
		pendingTaskSessionSummariesByWorkspaceId.delete(workspaceId);
		const summaries = Array.from(pending.values());
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (runtimeClients && runtimeClients.size > 0) {
			const payload: RuntimeStateStreamTaskSessionsMessage = {
				type: "task_sessions_updated",
				workspaceId,
				summaries,
			};
			for (const client of runtimeClients) {
				sendRuntimeStateMessage(client, payload);
			}
		}
		// The projects payload only carries coarse per-column task counts, which
		// change far less often than summary flushes fire (most flushes are
		// token/internal-state churn). Recompute just this workspace's counts (one
		// board read) and only fan out the all-projects rebuild when they actually
		// changed — otherwise a single active session triggered O(projects) full
		// board scans every 150ms.
		void (async () => {
			try {
				const changed = await deps.workspaceRegistry.refreshProjectTaskCountsIfChanged(workspaceId);
				if (changed) {
					await broadcastRuntimeProjectsUpdated(workspaceId);
				}
			} catch {
				// Never let a count refresh failure drop the projects broadcast: fall
				// back to the unconditional rebuild so the UI cannot get stuck stale.
				void broadcastRuntimeProjectsUpdated(workspaceId);
			}
		})();
	};

	const queueTaskSessionSummaryBroadcast = (workspaceId: string, summary: RuntimeTaskSessionSummary) => {
		const pending =
			pendingTaskSessionSummariesByWorkspaceId.get(workspaceId) ?? new Map<string, RuntimeTaskSessionSummary>();
		pending.set(summary.taskId, summary);
		pendingTaskSessionSummariesByWorkspaceId.set(workspaceId, pending);
		if (taskSessionBroadcastTimersByWorkspaceId.has(workspaceId)) {
			return;
		}
		const timer = setTimeout(() => {
			taskSessionBroadcastTimersByWorkspaceId.delete(workspaceId);
			flushTaskSessionSummaries(workspaceId);
		}, TASK_SESSION_STREAM_BATCH_MS);
		timer.unref();
		taskSessionBroadcastTimersByWorkspaceId.set(workspaceId, timer);
	};

	// Streaming chat tokens re-emit the whole accumulated message on every token;
	// the batcher coalesces them per (workspace, task, message id) so a long reply
	// becomes ~one send per CHAT_MESSAGE_STREAM_BATCH_MS instead of O(tokens) full
	// re-serializations on the event loop.
	const chatMessageBatcher = createTaskChatMessageBatcher({
		batchMs: CHAT_MESSAGE_STREAM_BATCH_MS,
		flush: ({ workspaceId, taskId, messages }) => {
			const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (!runtimeClients || runtimeClients.size === 0) {
				return;
			}
			for (const message of messages) {
				const payload: RuntimeStateStreamTaskChatMessage = {
					type: "task_chat_message",
					workspaceId,
					taskId,
					message,
				};
				for (const client of runtimeClients) {
					sendRuntimeStateMessage(client, payload);
				}
			}
		},
	});

	const broadcastTaskChatMessage = (workspaceId: string, taskId: string, message: SessionMessage) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			// No observers — skip entirely (the persisted journal is the source of
			// truth that a late-connecting client reads back via getTaskChatMessages).
			return;
		}
		chatMessageBatcher.enqueue(workspaceId, taskId, message);
	};

	const broadcastBoardSyncStatusUpdated = (workspaceId: string, status: RuntimeBoardSyncStatus) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamBoardSyncStatusMessage = {
			type: "board_sync_status_updated",
			workspaceId,
			status,
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const broadcastRuntimeOpsMetrics = (metrics: RuntimeOpsMetrics) => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamOpsMetricsMessage = {
			type: "runtime_metrics_updated",
			metrics,
		};
		for (const client of runtimeStateClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const broadcastTaskChatCleared = (workspaceId: string, taskId: string) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskChatClearedMessage = {
			type: "task_chat_cleared",
			workspaceId,
			taskId,
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const disposeTaskSessionSummaryBroadcast = (workspaceId: string) => {
		const timer = taskSessionBroadcastTimersByWorkspaceId.get(workspaceId);
		if (timer) {
			clearTimeout(timer);
		}
		taskSessionBroadcastTimersByWorkspaceId.delete(workspaceId);
		pendingTaskSessionSummariesByWorkspaceId.delete(workspaceId);
		chatMessageBatcher.disposeWorkspace(workspaceId);
	};

	const cleanupRuntimeStateClient = (client: WebSocket) => {
		const workspaceId = runtimeStateWorkspaceIdByClient.get(client);
		if (workspaceId) {
			workspaceMetadataMonitor.disconnectWorkspace(workspaceId);
			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (clients) {
				clients.delete(client);
				if (clients.size === 0) {
					runtimeStateClientsByWorkspaceId.delete(workspaceId);
				}
			}
		}
		runtimeStateWorkspaceIdByClient.delete(client);
		runtimeStateClients.delete(client);
	};

	const disposeWorkspace = (workspaceId: string, options?: DisposeRuntimeStateWorkspaceOptions) => {
		const unsubscribeSummary = terminalSummaryUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeSummary) {
			try {
				unsubscribeSummary();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		terminalSummaryUnsubscribeByWorkspaceId.delete(workspaceId);
		const unsubscribeTerminalMessage = terminalMessageUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeTerminalMessage) {
			try {
				unsubscribeTerminalMessage();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		terminalMessageUnsubscribeByWorkspaceId.delete(workspaceId);
		terminalPreviousSummaryByWorkspaceId.delete(workspaceId);
		// Pi service cleanup
		const unsubscribePiSummary = piSummaryUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribePiSummary) {
			try {
				unsubscribePiSummary();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		piSummaryUnsubscribeByWorkspaceId.delete(workspaceId);
		piPreviousSummaryByWorkspaceId.delete(workspaceId);
		const unsubscribePiMessage = piMessageUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribePiMessage) {
			try {
				unsubscribePiMessage();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		piMessageUnsubscribeByWorkspaceId.delete(workspaceId);
		disposeTaskSessionSummaryBroadcast(workspaceId);
		workspaceMetadataMonitor.disposeWorkspace(workspaceId);

		if (!options?.disconnectClients) {
			return;
		}

		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			runtimeStateClientsByWorkspaceId.delete(workspaceId);
			return;
		}

		for (const runtimeClient of runtimeClients) {
			if (options.closeClientErrorMessage) {
				sendRuntimeStateMessage(runtimeClient, {
					type: "error",
					message: options.closeClientErrorMessage,
				} satisfies RuntimeStateStreamErrorMessage);
			}
			try {
				runtimeClient.close();
			} catch {
				// Ignore close failures while disposing removed workspace clients.
			}
			cleanupRuntimeStateClient(runtimeClient);
		}
		runtimeStateClientsByWorkspaceId.delete(workspaceId);
	};

	const broadcastRuntimeWorkspaceStateUpdated = async (workspaceId: string, workspacePath: string): Promise<void> => {
		const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!clients || clients.size === 0) {
			return;
		}
		try {
			// Breadcrumb for the stall watchdog: assembling the board snapshot + the
			// metadata refresh fan out across tasks here on every broadcast.
			markStall("broadcast:workspace-state", workspaceId);
			const workspaceState = await deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, workspacePath);
			const payload: RuntimeStateStreamWorkspaceStateMessage = {
				type: "workspace_state_updated",
				workspaceId,
				workspaceState,
			};
			for (const client of clients) {
				sendRuntimeStateMessage(client, payload);
			}
			await workspaceMetadataMonitor.updateWorkspaceState({
				workspaceId,
				workspacePath,
				board: workspaceState.board,
			});
		} catch {
			// Ignore transient state read failures; next update will resync.
		}
	};

	const broadcastTaskReadyForReview = (workspaceId: string, taskId: string) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskReadyForReviewMessage = {
			type: "task_ready_for_review",
			workspaceId,
			taskId,
			triggeredAt: Date.now(),
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	runtimeStateWebSocketServer.on("connection", async (client: WebSocket, context: unknown) => {
		client.on("close", () => {
			cleanupRuntimeStateClient(client);
		});
		try {
			const requestedWorkspaceId =
				typeof context === "object" &&
				context !== null &&
				"requestedWorkspaceId" in context &&
				typeof (context as { requestedWorkspaceId?: unknown }).requestedWorkspaceId === "string"
					? (context as { requestedWorkspaceId: string }).requestedWorkspaceId || null
					: null;
			const workspace: ResolvedWorkspaceStreamTarget = await deps.workspaceRegistry.resolveWorkspaceForStream(
				requestedWorkspaceId,
				{
					onRemovedWorkspace: ({ workspaceId, message }) => {
						disposeWorkspace(workspaceId, {
							disconnectClients: true,
							closeClientErrorMessage: message,
						});
					},
				},
			);
			if (client.readyState !== WebSocket.OPEN) {
				cleanupRuntimeStateClient(client);
				return;
			}

			/*
				Connection setup for workspace-scoped runtime streams is intentionally split into two phases.

				We need the initial snapshot to already contain the first workspace metadata payload, but we do not want
				the client to receive a separate "workspace_metadata_updated" event before that snapshot arrives.

				That race can happen if we register the websocket in runtimeStateClientsByWorkspaceId first and then call
				workspaceMetadataMonitor.connectWorkspace(...). connectWorkspace() performs an immediate refresh, and that
				refresh may broadcast "workspace_metadata_updated" to every currently registered workspace client. In that
				old ordering, a newly connected client could observe:

				1. workspace_metadata_updated
				2. snapshot

				which makes the initial load look wrong and forces the UI to process the same logical data twice in the
				opposite order from what readers expect.

				To avoid that, we:

				1. add the socket only to the global runtimeStateClients set so project-wide broadcasts still work
				2. build workspace state and connect the metadata monitor to get the initial metadata snapshot
				3. send the combined "snapshot" message
				4. only then register the socket in runtimeStateClientsByWorkspaceId so future incremental
				   workspace_metadata_updated events can flow normally

				The extra readyState checks and monitor cleanup below are paired with this delayed registration. If the
				socket closes while we are still assembling or sending the initial snapshot, we must disconnect the
				temporary metadata monitor subscription before returning, otherwise we would leave behind subscriber count
				state for a client that never finished the handshake.
			*/
			runtimeStateClients.add(client);
			let monitorWorkspaceId: string | null = null;
			let didConnectWorkspaceMonitor = false;

			try {
				let projectsPayload: {
					currentProjectId: string | null;
					projects: RuntimeStateStreamProjectsMessage["projects"];
				};
				let workspaceState: RuntimeStateStreamSnapshotMessage["workspaceState"];
				let workspaceMetadata: RuntimeStateStreamSnapshotMessage["workspaceMetadata"];
				if (workspace.workspaceId && workspace.workspacePath) {
					monitorWorkspaceId = workspace.workspaceId;
					// Fast path: build the projects payload reading only the current project's
					// board (the snapshot reads it anyway). Non-current counts come from the
					// last-known cache; a full recompute is fired off the critical path below
					// to correct them, so a cold first-connect no longer blocks the snapshot on
					// an all-projects shard fan-out (F-CONN-2).
					[projectsPayload, workspaceState] = await Promise.all([
						deps.workspaceRegistry.buildProjectsPayloadFast(workspace.workspaceId),
						deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspace.workspaceId, workspace.workspacePath),
					]);
					workspaceMetadata = await workspaceMetadataMonitor.connectWorkspace({
						workspaceId: workspace.workspaceId,
						workspacePath: workspace.workspacePath,
						board: workspaceState.board,
					});
					didConnectWorkspaceMonitor = true;
				} else {
					projectsPayload = await deps.workspaceRegistry.buildProjectsPayloadFast(null);
					workspaceState = null;
					workspaceMetadata = null;
				}
				if (client.readyState !== WebSocket.OPEN) {
					if (monitorWorkspaceId) {
						workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
					}
					cleanupRuntimeStateClient(client);
					return;
				}
				sendRuntimeStateMessage(client, {
					type: "snapshot",
					currentProjectId: projectsPayload.currentProjectId,
					projects: projectsPayload.projects,
					workspaceState,
					workspaceMetadata,
					kanbanSessionContextVersion,
				} satisfies RuntimeStateStreamSnapshotMessage);
				if (client.readyState !== WebSocket.OPEN) {
					if (monitorWorkspaceId) {
						workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
					}
					cleanupRuntimeStateClient(client);
					return;
				}
				if (monitorWorkspaceId) {
					const workspaceClients =
						runtimeStateClientsByWorkspaceId.get(monitorWorkspaceId) ?? new Set<WebSocket>();
					workspaceClients.add(client);
					runtimeStateClientsByWorkspaceId.set(monitorWorkspaceId, workspaceClients);
					runtimeStateWorkspaceIdByClient.set(client, monitorWorkspaceId);
					const piSummaries = Array.from(piPreviousSummaryByWorkspaceId.get(monitorWorkspaceId)?.values() ?? []);
					if (piSummaries.length > 0) {
						sendRuntimeStateMessage(client, {
							type: "task_sessions_updated",
							workspaceId: monitorWorkspaceId,
							summaries: piSummaries,
						} satisfies RuntimeStateStreamTaskSessionsMessage);
					}
				}
				if (workspace.removedRequestedWorkspacePath) {
					sendRuntimeStateMessage(client, {
						type: "error",
						message: `Project no longer exists on disk and was removed: ${workspace.removedRequestedWorkspacePath}`,
					} satisfies RuntimeStateStreamErrorMessage);
				}
				// Correct the fast snapshot's non-current project counts off the connect
				// critical path: a full recompute reads every project's board and
				// broadcasts the authoritative counts via projects_updated. Skip when only
				// one project exists (the fast path already read it fresh) unless a prune
				// changed the project list and the client needs the refreshed roster.
				if (workspace.didPruneProjects || projectsPayload.projects.length > 1) {
					void broadcastRuntimeProjectsUpdated(projectsPayload.currentProjectId);
				}
			} catch (error) {
				if (didConnectWorkspaceMonitor && monitorWorkspaceId) {
					workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
				}
				const message = error instanceof Error ? error.message : String(error);
				sendRuntimeStateMessage(client, {
					type: "error",
					message,
				} satisfies RuntimeStateStreamErrorMessage);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendRuntimeStateMessage(client, {
				type: "error",
				message,
			} satisfies RuntimeStateStreamErrorMessage);
			client.close();
		}
	});

	return {
		trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => {
			if (terminalSummaryUnsubscribeByWorkspaceId.has(workspaceId)) {
				return;
			}
			const previousSummariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
			terminalPreviousSummaryByWorkspaceId.set(workspaceId, previousSummariesByTaskId);
			const unsubscribe = manager.onSummary((summary) => {
				const previousSummary = previousSummariesByTaskId.get(summary.taskId) ?? null;
				previousSummariesByTaskId.set(summary.taskId, summary);
				queueTaskSessionSummaryBroadcast(workspaceId, summary);
				emitTaskSessionTransition(workspaceId, previousSummary, summary);
			});
			terminalSummaryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribe);
			// CLI/terminal agents expose the same agent-agnostic transcript as pi;
			// stream their captured messages over the shared task_chat_message channel.
			const unsubscribeMessage = manager.onMessage((taskId, message) => {
				emitTaskChatMessage(workspaceId, taskId, message);
				broadcastTaskChatMessage(workspaceId, taskId, message);
			});
			terminalMessageUnsubscribeByWorkspaceId.set(workspaceId, unsubscribeMessage);
		},
		trackPiTaskSessionService: (workspaceId: string, workspacePath: string, service: PiTaskSessionService) => {
			if (piSummaryUnsubscribeByWorkspaceId.has(workspaceId)) {
				return;
			}
			const previousSummariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
			piPreviousSummaryByWorkspaceId.set(workspaceId, previousSummariesByTaskId);
			for (const summary of service.listSummaries()) {
				previousSummariesByTaskId.set(summary.taskId, summary);
				queueTaskSessionSummaryBroadcast(workspaceId, summary);
			}
			const unsubscribe = service.onSummary((summary) => {
				const previousSummary = previousSummariesByTaskId.get(summary.taskId);
				previousSummariesByTaskId.set(summary.taskId, summary);
				queueTaskSessionSummaryBroadcast(workspaceId, summary);
				const didCheckpointChange =
					previousSummary?.latestTurnCheckpoint?.commit !== summary.latestTurnCheckpoint?.commit ||
					previousSummary?.previousTurnCheckpoint?.commit !== summary.previousTurnCheckpoint?.commit;
				if (didCheckpointChange) {
					void broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
				}
				if (
					previousSummary &&
					previousSummary.state !== "awaiting_review" &&
					summary.state === "awaiting_review" &&
					(summary.reviewReason === "hook" ||
						summary.reviewReason === "attention" ||
						summary.reviewReason === "error")
				) {
					broadcastTaskReadyForReview(workspaceId, summary.taskId);
				}
				emitTaskSessionTransition(workspaceId, previousSummary ?? null, summary);
			});
			piSummaryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribe);
			const unsubscribeMessage = service.onMessage((taskId, message) => {
				emitTaskChatMessage(workspaceId, taskId, message);
				broadcastTaskChatMessage(workspaceId, taskId, message);
			});
			piMessageUnsubscribeByWorkspaceId.set(workspaceId, unsubscribeMessage);
		},
		broadcastTaskChatMessage,
		broadcastTaskChatCleared,
		handleUpgrade: (request, socket, head, context) => {
			runtimeStateWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
				runtimeStateWebSocketServer.emit("connection", ws, context);
			});
		},
		disposeWorkspace,
		broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated,
		broadcastKanbanMcpAuthStatusesUpdated,
		broadcastBoardSyncStatusUpdated,
		broadcastRuntimeOpsMetrics,
		bumpKanbanSessionContextVersion,
		broadcastTaskReadyForReview,
		close: async () => {
			for (const timer of taskSessionBroadcastTimersByWorkspaceId.values()) {
				clearTimeout(timer);
			}
			taskSessionBroadcastTimersByWorkspaceId.clear();
			pendingTaskSessionSummariesByWorkspaceId.clear();
			chatMessageBatcher.dispose();
			for (const unsubscribe of terminalSummaryUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			terminalSummaryUnsubscribeByWorkspaceId.clear();
			for (const unsubscribe of terminalMessageUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			terminalMessageUnsubscribeByWorkspaceId.clear();
			terminalPreviousSummaryByWorkspaceId.clear();
			// Pi service cleanup
			for (const unsubscribe of piSummaryUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			piSummaryUnsubscribeByWorkspaceId.clear();
			piPreviousSummaryByWorkspaceId.clear();
			for (const unsubscribe of piMessageUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			piMessageUnsubscribeByWorkspaceId.clear();
			workspaceMetadataMonitor.close();
			for (const client of runtimeStateClients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			runtimeStateClients.clear();
			runtimeStateClientsByWorkspaceId.clear();
			runtimeStateWorkspaceIdByClient.clear();
			await new Promise<void>((resolveCloseWebSockets) => {
				runtimeStateWebSocketServer.close(() => {
					resolveCloseWebSockets();
				});
			});
		},
	};
}
