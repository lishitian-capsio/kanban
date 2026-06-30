// Singleton store for the runtime state stream, with granular selector
// subscriptions.
//
// The runtime delivers everything (board/sessions/chat/projects/sync) over a
// single WebSocket. Previously every message flowed through one `useReducer`
// consumed at the top of `App`, so a chat token or a ~5s board-sync badge
// update re-rendered the whole tree. This module keeps the SAME pure reducer as
// the transition source of truth, but delivers updates through per-field
// listener sets (plus per-taskId chat listeners) read via `useSyncExternalStore`
// — the same model as `stores/workspace-metadata-store.ts`. A chat token now
// only wakes the panel(s) subscribed to that task; the sync badge only wakes its
// own control.
import { useCallback, useSyncExternalStore } from "react";

import { parseProjectIdFromPathname } from "@/hooks/app-utils";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import type {
	RuntimeBoardData,
	RuntimeBoardSyncStatus,
	RuntimeKanbanMcpServerAuthStatus,
	RuntimeOpsMetrics,
	RuntimeProjectSummary,
	RuntimeStateStreamBoardSyncStatusMessage,
	RuntimeStateStreamKanbanSessionContextUpdatedMessage,
	RuntimeStateStreamMcpAuthUpdatedMessage,
	RuntimeStateStreamOpsMetricsMessage,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskChatClearedMessage,
	RuntimeStateStreamTaskChatMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceMetadata,
	RuntimeWorkspaceStateResponse,
} from "@/runtime/types";

export interface RuntimeStateStreamStore {
	currentProjectId: string | null;
	projects: RuntimeProjectSummary[];
	workspaceState: RuntimeWorkspaceStateResponse | null;
	workspaceMetadata: RuntimeWorkspaceMetadata | null;
	latestTaskChatMessage: RuntimeStateStreamTaskChatMessage | null;
	taskChatMessagesByTaskId: Record<string, RuntimeTaskChatMessage[]>;
	// Per-task session summaries, subscribed at the leaf (BoardCard / CardDetailView)
	// via `useTaskSessionSummary`. This mirrors the per-task chat channel: the
	// high-frequency `task_sessions_updated` broadcast (~150ms) wakes only the one
	// card whose summary changed, instead of the App-level `workspaceState` slice
	// re-rendering the whole board subtree. `workspaceState.sessions` is still
	// maintained in parallel (it drives App's auto-column-move effect and
	// persistence); this slice is the read-optimized display channel.
	sessionSummaryByTaskId: Record<string, RuntimeTaskSessionSummary>;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	latestMcpAuthStatuses: RuntimeKanbanMcpServerAuthStatus[] | null;
	kanbanSessionContextVersion: number;
	boardSyncStatus: RuntimeBoardSyncStatus | null;
	opsMetrics: RuntimeOpsMetrics | null;
	opsMetricsHistory: RuntimeOpsMetrics[];
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
}

export type RuntimeStateStreamAction =
	| { type: "initialize"; requestedWorkspaceId: string | null }
	| { type: "requested_workspace_changed" }
	| { type: "stream_connected" }
	| { type: "snapshot"; payload: RuntimeStateStreamSnapshotMessage }
	| {
			type: "projects_updated";
			payload: RuntimeStateStreamProjectsMessage;
			nextProjectId: string | null;
	  }
	| { type: "task_chat_message"; payload: RuntimeStateStreamTaskChatMessage }
	| { type: "task_chat_cleared"; payload: RuntimeStateStreamTaskChatClearedMessage }
	| { type: "workspace_metadata_updated"; workspaceMetadata: RuntimeWorkspaceMetadata }
	| { type: "task_ready_for_review"; payload: RuntimeStateStreamTaskReadyForReviewMessage }
	| { type: "mcp_auth_updated"; payload: RuntimeStateStreamMcpAuthUpdatedMessage }
	| { type: "kanban_session_context_updated"; payload: RuntimeStateStreamKanbanSessionContextUpdatedMessage }
	| { type: "board_sync_status_updated"; payload: RuntimeStateStreamBoardSyncStatusMessage }
	| { type: "runtime_metrics_updated"; payload: RuntimeStateStreamOpsMetricsMessage }
	| { type: "workspace_state_updated"; workspaceState: RuntimeWorkspaceStateResponse }
	| { type: "task_sessions_updated"; summaries: RuntimeTaskSessionSummary[] }
	| { type: "stream_error"; message: string }
	| { type: "stream_disconnected"; message: string };

/**
 * Cap on the rolling ops-metrics history retained for the status-bar sparklines.
 * At the ~2.5s `runtime_metrics_updated` cadence, 60 samples ≈ 2.5 minutes of
 * trend. Oldest samples are dropped when the buffer is full.
 */
export const OPS_METRICS_HISTORY_LIMIT = 60;

/**
 * Cap on the live in-memory transcript retained per task. The streaming buffer
 * only needs the recent tail for display (Virtuoso virtualizes it, and the
 * backend journal persists the full history, re-fetched on panel open). Without
 * a cap the array grew unbounded by message count across a long session and was
 * fully cloned + `JSON.stringify`-compared on every token, which is real GC
 * churn. When the cap is exceeded the oldest messages are dropped from the live
 * buffer (no synthetic marker — the panel's history fetch backfills older ones).
 */
export const TASK_CHAT_MESSAGE_LIMIT = 1_000;

function appendOpsMetricsSample(history: RuntimeOpsMetrics[], sample: RuntimeOpsMetrics): RuntimeOpsMetrics[] {
	const next = [...history, sample];
	if (next.length > OPS_METRICS_HISTORY_LIMIT) {
		next.splice(0, next.length - OPS_METRICS_HISTORY_LIMIT);
	}
	return next;
}

function mergeTaskSessionSummaries(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	summaries: RuntimeTaskSessionSummary[],
): Record<string, RuntimeTaskSessionSummary> {
	if (summaries.length === 0) {
		return currentSessions;
	}
	const nextSessions = { ...currentSessions };
	for (const summary of summaries) {
		const existing = nextSessions[summary.taskId];
		if (!existing || existing.updatedAt <= summary.updatedAt) {
			nextSessions[summary.taskId] = summary;
		}
	}
	return nextSessions;
}

// Merge incoming summaries into the per-task display slice, preferring the
// newest by `updatedAt` (the same monotonic rule App's local session state uses
// — see the "terminal randomly clears out" guard in `use-task-sessions.ts`).
// Returns the same reference when nothing changed so the store dispatch skips
// the per-task listener wake.
function mergeSessionSummaryByTaskId(
	current: Record<string, RuntimeTaskSessionSummary>,
	summaries: RuntimeTaskSessionSummary[],
): Record<string, RuntimeTaskSessionSummary> {
	if (summaries.length === 0) {
		return current;
	}
	let next: Record<string, RuntimeTaskSessionSummary> | null = null;
	for (const summary of summaries) {
		const existing = current[summary.taskId] ?? null;
		const newest = selectNewestTaskSessionSummary(existing, summary);
		if (newest === existing) {
			continue;
		}
		if (!next) {
			next = { ...current };
		}
		next[summary.taskId] = summary;
	}
	return next ?? current;
}

// Evict the per-task chat buffers (and `latestTaskChatMessage`, when it points
// at an evicted task) for tasks that were on the *previous* board but are gone
// from the *next* one — e.g. trash cleared or a hard delete. Without this the
// `taskChatMessagesByTaskId` map only ever grew: the cap bounds each array, but
// keys for churned-through tasks (done == trash is a high-churn 终态桶) never
// left. The previous→next board *diff* is deliberate: only ids that were genuine
// board cards can be flagged removed, so the synthetic `__home_agent__:…`
// home-chat session ids — which never appear on the board — are never evicted.
// The backend journal stays the source of truth; a re-added task re-fetches its
// history on panel open. Returns the same references when nothing was removed so
// the dispatch skips the chat-listener wake.
function pruneChatForRemovedTasks(
	taskChatMessagesByTaskId: Record<string, RuntimeTaskChatMessage[]>,
	latestTaskChatMessage: RuntimeStateStreamTaskChatMessage | null,
	previousBoard: RuntimeBoardData | null | undefined,
	nextBoard: RuntimeBoardData,
): {
	taskChatMessagesByTaskId: Record<string, RuntimeTaskChatMessage[]>;
	latestTaskChatMessage: RuntimeStateStreamTaskChatMessage | null;
} {
	if (!previousBoard) {
		return { taskChatMessagesByTaskId, latestTaskChatMessage };
	}
	const nextIds = new Set<string>();
	for (const column of nextBoard.columns) {
		for (const card of column.cards) {
			nextIds.add(card.id);
		}
	}
	const removed: string[] = [];
	for (const column of previousBoard.columns) {
		for (const card of column.cards) {
			if (!nextIds.has(card.id) && card.id in taskChatMessagesByTaskId) {
				removed.push(card.id);
			}
		}
	}
	if (removed.length === 0) {
		return { taskChatMessagesByTaskId, latestTaskChatMessage };
	}
	const nextMessages = { ...taskChatMessagesByTaskId };
	for (const id of removed) {
		delete nextMessages[id];
	}
	const nextLatest =
		latestTaskChatMessage && removed.includes(latestTaskChatMessage.taskId) ? null : latestTaskChatMessage;
	return { taskChatMessagesByTaskId: nextMessages, latestTaskChatMessage: nextLatest };
}

export function createInitialRuntimeStateStreamStore(requestedWorkspaceId: string | null): RuntimeStateStreamStore {
	return {
		currentProjectId: requestedWorkspaceId,
		projects: [],
		workspaceState: null,
		workspaceMetadata: null,
		latestTaskChatMessage: null,
		taskChatMessagesByTaskId: {},
		sessionSummaryByTaskId: {},
		latestTaskReadyForReview: null,
		latestMcpAuthStatuses: null,
		kanbanSessionContextVersion: 0,
		boardSyncStatus: null,
		opsMetrics: null,
		opsMetricsHistory: [],
		streamError: null,
		isRuntimeDisconnected: false,
		hasReceivedSnapshot: false,
	};
}

function upsertTaskChatMessage(
	currentMessages: RuntimeTaskChatMessage[],
	nextMessage: RuntimeTaskChatMessage,
): RuntimeTaskChatMessage[] {
	const existingIndex = currentMessages.findIndex((message) => message.id === nextMessage.id);
	if (existingIndex < 0) {
		const appended = [...currentMessages, nextMessage];
		if (appended.length > TASK_CHAT_MESSAGE_LIMIT) {
			appended.splice(0, appended.length - TASK_CHAT_MESSAGE_LIMIT);
		}
		return appended;
	}
	const existingMessage = currentMessages[existingIndex];
	if (
		existingMessage &&
		existingMessage.content === nextMessage.content &&
		existingMessage.role === nextMessage.role &&
		existingMessage.createdAt === nextMessage.createdAt &&
		JSON.stringify(existingMessage.meta ?? null) === JSON.stringify(nextMessage.meta ?? null)
	) {
		return currentMessages;
	}
	const nextMessages = [...currentMessages];
	nextMessages[existingIndex] = nextMessage;
	return nextMessages;
}

export function resolveProjectIdAfterProjectsUpdate(
	currentProjectId: string | null,
	payload: RuntimeStateStreamProjectsMessage,
): string | null {
	if (currentProjectId && payload.projects.some((project) => project.id === currentProjectId)) {
		return currentProjectId;
	}
	return payload.currentProjectId;
}

export function runtimeStateStreamReducer(
	state: RuntimeStateStreamStore,
	action: RuntimeStateStreamAction,
): RuntimeStateStreamStore {
	if (action.type === "initialize") {
		return createInitialRuntimeStateStreamStore(action.requestedWorkspaceId);
	}
	if (action.type === "requested_workspace_changed") {
		return {
			...state,
			workspaceState: null,
			workspaceMetadata: null,
			latestTaskChatMessage: null,
			taskChatMessagesByTaskId: {},
			sessionSummaryByTaskId: {},
			streamError: null,
			isRuntimeDisconnected: false,
			hasReceivedSnapshot: false,
			latestMcpAuthStatuses: state.latestMcpAuthStatuses,
			kanbanSessionContextVersion: state.kanbanSessionContextVersion,
			boardSyncStatus: null,
			// Drop the trend history on a workspace switch so the sparklines don't
			// stitch one workspace's samples onto another's (instantaneous metrics
			// are process-global and harmless to keep, but a continuous line across
			// the switch would be misleading).
			opsMetricsHistory: [],
		};
	}
	if (action.type === "stream_connected") {
		return {
			...state,
			streamError: null,
			isRuntimeDisconnected: false,
		};
	}
	if (action.type === "snapshot") {
		const nextWorkspaceState = action.payload.workspaceState
			? {
					...action.payload.workspaceState,
					sessions: mergeTaskSessionSummaries(
						state.workspaceState?.sessions ?? {},
						Object.values(action.payload.workspaceState.sessions ?? {}),
					),
				}
			: null;
		return {
			currentProjectId: action.payload.currentProjectId,
			projects: action.payload.projects,
			workspaceState: nextWorkspaceState,
			workspaceMetadata: action.payload.workspaceMetadata,
			latestTaskChatMessage: null,
			taskChatMessagesByTaskId: {},
			sessionSummaryByTaskId: mergeSessionSummaryByTaskId({}, Object.values(nextWorkspaceState?.sessions ?? {})),
			latestTaskReadyForReview: state.latestTaskReadyForReview,
			latestMcpAuthStatuses: state.latestMcpAuthStatuses,
			kanbanSessionContextVersion: action.payload.kanbanSessionContextVersion,
			boardSyncStatus: null,
			// Ops metrics are process-global, not workspace-scoped — keep the last
			// sample across a re-snapshot so the status bar doesn't blank out. The
			// trend history, however, resets: a snapshot marks a fresh connection
			// (e.g. after a disconnect/reconnect gap) and a continuous sparkline
			// across that gap would be misleading.
			opsMetrics: state.opsMetrics,
			opsMetricsHistory: [],
			streamError: null,
			isRuntimeDisconnected: false,
			hasReceivedSnapshot: true,
		};
	}
	if (action.type === "projects_updated") {
		const didProjectChange = action.nextProjectId !== state.currentProjectId;
		return {
			...state,
			currentProjectId: action.nextProjectId,
			projects: action.payload.projects,
			workspaceState: didProjectChange ? null : state.workspaceState,
			workspaceMetadata: didProjectChange ? null : state.workspaceMetadata,
			latestTaskChatMessage: didProjectChange ? null : state.latestTaskChatMessage,
			taskChatMessagesByTaskId: didProjectChange ? {} : state.taskChatMessagesByTaskId,
			sessionSummaryByTaskId: didProjectChange ? {} : state.sessionSummaryByTaskId,
			latestTaskReadyForReview: didProjectChange ? null : state.latestTaskReadyForReview,
			boardSyncStatus: didProjectChange ? null : state.boardSyncStatus,
			hasReceivedSnapshot: true,
		};
	}
	if (action.type === "task_chat_message") {
		const currentTaskMessages = state.taskChatMessagesByTaskId[action.payload.taskId] ?? [];
		return {
			...state,
			latestTaskChatMessage: action.payload,
			taskChatMessagesByTaskId: {
				...state.taskChatMessagesByTaskId,
				[action.payload.taskId]: upsertTaskChatMessage(currentTaskMessages, action.payload.message),
			},
		};
	}
	if (action.type === "task_chat_cleared") {
		return {
			...state,
			latestTaskChatMessage: null,
			taskChatMessagesByTaskId: {
				...state.taskChatMessagesByTaskId,
				[action.payload.taskId]: [],
			},
		};
	}
	if (action.type === "workspace_metadata_updated") {
		return {
			...state,
			workspaceMetadata: action.workspaceMetadata,
		};
	}
	if (action.type === "task_ready_for_review") {
		return {
			...state,
			latestTaskReadyForReview: action.payload,
		};
	}
	if (action.type === "mcp_auth_updated") {
		return {
			...state,
			latestMcpAuthStatuses: action.payload.statuses,
		};
	}
	if (action.type === "kanban_session_context_updated") {
		return {
			...state,
			kanbanSessionContextVersion: action.payload.version,
		};
	}
	if (action.type === "board_sync_status_updated") {
		return {
			...state,
			boardSyncStatus: action.payload.status,
		};
	}
	if (action.type === "runtime_metrics_updated") {
		return {
			...state,
			opsMetrics: action.payload.metrics,
			opsMetricsHistory: appendOpsMetricsSample(state.opsMetricsHistory, action.payload.metrics),
		};
	}
	if (action.type === "workspace_state_updated") {
		const mergedWorkspaceState = {
			...action.workspaceState,
			sessions: mergeTaskSessionSummaries(
				state.workspaceState?.sessions ?? {},
				Object.values(action.workspaceState.sessions ?? {}),
			),
		};
		const pruned = pruneChatForRemovedTasks(
			state.taskChatMessagesByTaskId,
			state.latestTaskChatMessage,
			state.workspaceState?.board,
			action.workspaceState.board,
		);
		return {
			...state,
			workspaceState: mergedWorkspaceState,
			sessionSummaryByTaskId: mergeSessionSummaryByTaskId(
				state.sessionSummaryByTaskId,
				Object.values(action.workspaceState.sessions ?? {}),
			),
			taskChatMessagesByTaskId: pruned.taskChatMessagesByTaskId,
			latestTaskChatMessage: pruned.latestTaskChatMessage,
		};
	}
	if (action.type === "task_sessions_updated") {
		// The per-task display slice updates regardless of whether a workspace
		// snapshot has landed yet — leaf cards read it directly. `workspaceState`
		// keeps its existing merge (gated on having a snapshot) so App's
		// auto-column-move effect and persistence are unchanged.
		const nextSessionSummaryByTaskId = mergeSessionSummaryByTaskId(state.sessionSummaryByTaskId, action.summaries);
		if (!state.workspaceState) {
			if (nextSessionSummaryByTaskId === state.sessionSummaryByTaskId) {
				return state;
			}
			return { ...state, sessionSummaryByTaskId: nextSessionSummaryByTaskId };
		}
		return {
			...state,
			workspaceState: {
				...state.workspaceState,
				sessions: mergeTaskSessionSummaries(state.workspaceState.sessions, action.summaries),
			},
			sessionSummaryByTaskId: nextSessionSummaryByTaskId,
		};
	}
	if (action.type === "stream_error") {
		return {
			...state,
			streamError: action.message,
			isRuntimeDisconnected: false,
		};
	}
	if (action.type === "stream_disconnected") {
		return {
			...state,
			streamError: action.message,
			isRuntimeDisconnected: true,
		};
	}
	return state;
}

// ---------------------------------------------------------------------------
// Singleton store + granular subscriptions
// ---------------------------------------------------------------------------

const FIELD_KEYS = [
	"currentProjectId",
	"projects",
	"workspaceState",
	"workspaceMetadata",
	"latestTaskReadyForReview",
	"latestMcpAuthStatuses",
	"kanbanSessionContextVersion",
	"boardSyncStatus",
	"opsMetrics",
	"opsMetricsHistory",
	"streamError",
	"isRuntimeDisconnected",
	"hasReceivedSnapshot",
] as const satisfies ReadonlyArray<keyof RuntimeStateStreamStore>;

type FieldKey = (typeof FIELD_KEYS)[number];

type Listener = () => void;

function readInitialWorkspaceIdFromLocation(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	return parseProjectIdFromPathname(window.location.pathname);
}

// Seed `currentProjectId` from the URL at module load so the first render reads
// it before the connection effect runs — matching the old useReducer
// initializer and avoiding a one-frame loading-state flash on cold load.
let store: RuntimeStateStreamStore = createInitialRuntimeStateStreamStore(readInitialWorkspaceIdFromLocation());

const fieldListeners = Object.fromEntries(FIELD_KEYS.map((key) => [key, new Set<Listener>()])) as Record<
	FieldKey,
	Set<Listener>
>;
const fieldSubscribers = Object.fromEntries(
	FIELD_KEYS.map((key) => [
		key,
		(listener: Listener) => {
			fieldListeners[key].add(listener);
			return () => {
				fieldListeners[key].delete(listener);
			};
		},
	]),
) as Record<FieldKey, (listener: Listener) => () => void>;

// Chat is subscribed per-task so a token for task A never wakes task B's panel.
const taskChatListenersByTaskId = new Map<string, Set<Listener>>();

// Session summaries are likewise subscribed per-task so the high-frequency
// `task_sessions_updated` broadcast only wakes the card whose summary changed.
const taskSessionListenersByTaskId = new Map<string, Set<Listener>>();

function emit(listeners: Set<Listener> | undefined): void {
	if (!listeners) {
		return;
	}
	for (const listener of listeners) {
		listener();
	}
}

function emitAffectedChatTasks(prev: RuntimeStateStreamStore, next: RuntimeStateStreamStore): void {
	const affected = new Set<string>();
	const taskIds = new Set([
		...Object.keys(prev.taskChatMessagesByTaskId),
		...Object.keys(next.taskChatMessagesByTaskId),
	]);
	for (const taskId of taskIds) {
		if (prev.taskChatMessagesByTaskId[taskId] !== next.taskChatMessagesByTaskId[taskId]) {
			affected.add(taskId);
		}
	}
	if (prev.latestTaskChatMessage?.taskId) {
		affected.add(prev.latestTaskChatMessage.taskId);
	}
	if (next.latestTaskChatMessage?.taskId) {
		affected.add(next.latestTaskChatMessage.taskId);
	}
	for (const taskId of affected) {
		emit(taskChatListenersByTaskId.get(taskId));
	}
}

function emitAffectedSessionTasks(prev: RuntimeStateStreamStore, next: RuntimeStateStreamStore): void {
	const taskIds = new Set([...Object.keys(prev.sessionSummaryByTaskId), ...Object.keys(next.sessionSummaryByTaskId)]);
	for (const taskId of taskIds) {
		if (prev.sessionSummaryByTaskId[taskId] !== next.sessionSummaryByTaskId[taskId]) {
			emit(taskSessionListenersByTaskId.get(taskId));
		}
	}
}

export function dispatchRuntimeStreamAction(action: RuntimeStateStreamAction): void {
	const prev = store;
	const next = runtimeStateStreamReducer(prev, action);
	if (next === prev) {
		return;
	}
	store = next;
	for (const key of FIELD_KEYS) {
		if (prev[key] !== next[key]) {
			emit(fieldListeners[key]);
		}
	}
	if (
		prev.taskChatMessagesByTaskId !== next.taskChatMessagesByTaskId ||
		prev.latestTaskChatMessage !== next.latestTaskChatMessage
	) {
		emitAffectedChatTasks(prev, next);
	}
	if (prev.sessionSummaryByTaskId !== next.sessionSummaryByTaskId) {
		emitAffectedSessionTasks(prev, next);
	}
}

/** Non-reactive snapshot read — for tests and imperative call sites. */
export function getRuntimeStreamStore(): RuntimeStateStreamStore {
	return store;
}

/**
 * Push a locally-produced session summary (from `startTaskSession`, terminal
 * `onSummary`, chat `onSessionSummary`, …) into the per-task display slice so the
 * card reflects it immediately, without waiting for the ~150ms websocket
 * `task_sessions_updated` echo. The merge is monotonic (newest `updatedAt`
 * wins), so a stale replay can't clobber a newer running session. App's local
 * `sessions` state is still updated in parallel for the auto-column-move effect.
 */
export function applyLocalTaskSessionSummary(summary: RuntimeTaskSessionSummary): void {
	const prev = store;
	const nextSessionSummaryByTaskId = mergeSessionSummaryByTaskId(prev.sessionSummaryByTaskId, [summary]);
	if (nextSessionSummaryByTaskId === prev.sessionSummaryByTaskId) {
		return;
	}
	store = { ...prev, sessionSummaryByTaskId: nextSessionSummaryByTaskId };
	emitAffectedSessionTasks(prev, store);
}

/** Test-only: reset the singleton and drop all listeners. */
export function resetRuntimeStreamStoreForTest(): void {
	store = createInitialRuntimeStateStreamStore(null);
	for (const key of FIELD_KEYS) {
		fieldListeners[key].clear();
	}
	taskChatListenersByTaskId.clear();
	taskSessionListenersByTaskId.clear();
}

function useField<Value>(key: FieldKey, select: (snapshot: RuntimeStateStreamStore) => Value): Value {
	const getSnapshot = useCallback(() => select(store), [select]);
	return useSyncExternalStore(fieldSubscribers[key], getSnapshot, getSnapshot);
}

// Stable selector identities so `useField`'s getSnapshot stays referentially
// stable across renders (it depends on the selector).
const selectCurrentProjectId = (snapshot: RuntimeStateStreamStore) => snapshot.currentProjectId;
const selectProjects = (snapshot: RuntimeStateStreamStore) => snapshot.projects;
const selectWorkspaceState = (snapshot: RuntimeStateStreamStore) => snapshot.workspaceState;
const selectWorkspaceMetadata = (snapshot: RuntimeStateStreamStore) => snapshot.workspaceMetadata;
const selectLatestTaskReadyForReview = (snapshot: RuntimeStateStreamStore) => snapshot.latestTaskReadyForReview;
const selectStreamError = (snapshot: RuntimeStateStreamStore) => snapshot.streamError;
const selectIsRuntimeDisconnected = (snapshot: RuntimeStateStreamStore) => snapshot.isRuntimeDisconnected;
const selectHasReceivedSnapshot = (snapshot: RuntimeStateStreamStore) => snapshot.hasReceivedSnapshot;
const selectKanbanSessionContextVersion = (snapshot: RuntimeStateStreamStore) => snapshot.kanbanSessionContextVersion;
const selectBoardSyncStatus = (snapshot: RuntimeStateStreamStore) => snapshot.boardSyncStatus;
const selectOpsMetrics = (snapshot: RuntimeStateStreamStore) => snapshot.opsMetrics;
const selectOpsMetricsHistory = (snapshot: RuntimeStateStreamStore) => snapshot.opsMetricsHistory;

export function useRuntimeCurrentProjectId(): string | null {
	return useField("currentProjectId", selectCurrentProjectId);
}

export function useRuntimeProjects(): RuntimeProjectSummary[] {
	return useField("projects", selectProjects);
}

export function useRuntimeWorkspaceState(): RuntimeWorkspaceStateResponse | null {
	return useField("workspaceState", selectWorkspaceState);
}

export function useRuntimeWorkspaceMetadata(): RuntimeWorkspaceMetadata | null {
	return useField("workspaceMetadata", selectWorkspaceMetadata);
}

export function useRuntimeLatestTaskReadyForReview(): RuntimeStateStreamTaskReadyForReviewMessage | null {
	return useField("latestTaskReadyForReview", selectLatestTaskReadyForReview);
}

export function useRuntimeStreamError(): string | null {
	return useField("streamError", selectStreamError);
}

export function useRuntimeIsDisconnected(): boolean {
	return useField("isRuntimeDisconnected", selectIsRuntimeDisconnected);
}

export function useRuntimeHasReceivedSnapshot(): boolean {
	return useField("hasReceivedSnapshot", selectHasReceivedSnapshot);
}

export function useRuntimeKanbanSessionContextVersion(): number {
	return useField("kanbanSessionContextVersion", selectKanbanSessionContextVersion);
}

export function useRuntimeBoardSyncStatus(): RuntimeBoardSyncStatus | null {
	return useField("boardSyncStatus", selectBoardSyncStatus);
}

/**
 * The latest runtime ops metrics (process RSS / CPU% / event-loop stall state).
 * Subscribe ONLY in the leaf status-bar component so the ~2.5s metrics broadcast
 * re-renders just that bar, not the rest of the tree.
 */
export function useRuntimeOpsMetrics(): RuntimeOpsMetrics | null {
	return useField("opsMetrics", selectOpsMetrics);
}

/**
 * The rolling window of recent runtime ops-metrics samples (oldest → newest,
 * capped at {@link OPS_METRICS_HISTORY_LIMIT}) for the status-bar sparklines.
 * Like {@link useRuntimeOpsMetrics}, subscribe ONLY in the leaf status-bar
 * component so the ~2.5s metrics broadcast re-renders just that bar.
 */
export function useRuntimeOpsMetricsHistory(): RuntimeOpsMetrics[] {
	return useField("opsMetricsHistory", selectOpsMetricsHistory);
}

function subscribeTaskChat(taskId: string, listener: Listener): () => void {
	let listeners = taskChatListenersByTaskId.get(taskId);
	if (!listeners) {
		listeners = new Set<Listener>();
		taskChatListenersByTaskId.set(taskId, listeners);
	}
	listeners.add(listener);
	return () => {
		const current = taskChatListenersByTaskId.get(taskId);
		if (!current) {
			return;
		}
		current.delete(listener);
		if (current.size === 0) {
			taskChatListenersByTaskId.delete(taskId);
		}
	};
}

/**
 * The streamed transcript for a single task. Subscribes only to that task's
 * chat channel — a token for another task never re-renders this consumer.
 */
export function useTaskChatMessages(taskId: string | null | undefined): RuntimeTaskChatMessage[] | null {
	const normalizedTaskId = taskId?.trim() ?? "";
	const subscribe = useCallback(
		(listener: Listener) => (normalizedTaskId ? subscribeTaskChat(normalizedTaskId, listener) : () => {}),
		[normalizedTaskId],
	);
	const getSnapshot = useCallback(
		() => (normalizedTaskId ? (store.taskChatMessagesByTaskId[normalizedTaskId] ?? null) : null),
		[normalizedTaskId],
	);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The latest streamed chat envelope, but only when it belongs to `taskId`
 * (otherwise null). Subscribes to the same per-task channel as
 * {@link useTaskChatMessages}.
 */
export function useLatestTaskChatMessageForTask(taskId: string | null | undefined): RuntimeTaskChatMessage | null {
	const normalizedTaskId = taskId?.trim() ?? "";
	const subscribe = useCallback(
		(listener: Listener) => (normalizedTaskId ? subscribeTaskChat(normalizedTaskId, listener) : () => {}),
		[normalizedTaskId],
	);
	const getSnapshot = useCallback(() => {
		const latest = store.latestTaskChatMessage;
		return latest && normalizedTaskId && latest.taskId === normalizedTaskId ? latest.message : null;
	}, [normalizedTaskId]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribeTaskSession(taskId: string, listener: Listener): () => void {
	let listeners = taskSessionListenersByTaskId.get(taskId);
	if (!listeners) {
		listeners = new Set<Listener>();
		taskSessionListenersByTaskId.set(taskId, listeners);
	}
	listeners.add(listener);
	return () => {
		const current = taskSessionListenersByTaskId.get(taskId);
		if (!current) {
			return;
		}
		current.delete(listener);
		if (current.size === 0) {
			taskSessionListenersByTaskId.delete(taskId);
		}
	};
}

/**
 * The live session summary for a single task. Subscribes only to that task's
 * session channel — a `task_sessions_updated` tick for another task never
 * re-renders this consumer. Subscribe in the LEAF that displays it (BoardCard /
 * CardDetailView) so the board subtree is not re-rendered every ~150ms.
 */
export function useTaskSessionSummary(taskId: string | null | undefined): RuntimeTaskSessionSummary | null {
	const normalizedTaskId = taskId?.trim() ?? "";
	const subscribe = useCallback(
		(listener: Listener) => (normalizedTaskId ? subscribeTaskSession(normalizedTaskId, listener) : () => {}),
		[normalizedTaskId],
	);
	const getSnapshot = useCallback(
		() => (normalizedTaskId ? (store.sessionSummaryByTaskId[normalizedTaskId] ?? null) : null),
		[normalizedTaskId],
	);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
