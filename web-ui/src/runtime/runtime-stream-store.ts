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
import type {
	RuntimeBoardSyncStatus,
	RuntimeKanbanMcpServerAuthStatus,
	RuntimeProjectSummary,
	RuntimeStateStreamBoardSyncStatusMessage,
	RuntimeStateStreamKanbanSessionContextUpdatedMessage,
	RuntimeStateStreamMcpAuthUpdatedMessage,
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
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	latestMcpAuthStatuses: RuntimeKanbanMcpServerAuthStatus[] | null;
	kanbanSessionContextVersion: number;
	boardSyncStatus: RuntimeBoardSyncStatus | null;
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
	| { type: "workspace_state_updated"; workspaceState: RuntimeWorkspaceStateResponse }
	| { type: "task_sessions_updated"; summaries: RuntimeTaskSessionSummary[] }
	| { type: "stream_error"; message: string }
	| { type: "stream_disconnected"; message: string };

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

export function createInitialRuntimeStateStreamStore(requestedWorkspaceId: string | null): RuntimeStateStreamStore {
	return {
		currentProjectId: requestedWorkspaceId,
		projects: [],
		workspaceState: null,
		workspaceMetadata: null,
		latestTaskChatMessage: null,
		taskChatMessagesByTaskId: {},
		latestTaskReadyForReview: null,
		latestMcpAuthStatuses: null,
		kanbanSessionContextVersion: 0,
		boardSyncStatus: null,
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
		return [...currentMessages, nextMessage];
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
			streamError: null,
			isRuntimeDisconnected: false,
			hasReceivedSnapshot: false,
			latestMcpAuthStatuses: state.latestMcpAuthStatuses,
			kanbanSessionContextVersion: state.kanbanSessionContextVersion,
			boardSyncStatus: null,
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
			latestTaskReadyForReview: state.latestTaskReadyForReview,
			latestMcpAuthStatuses: state.latestMcpAuthStatuses,
			kanbanSessionContextVersion: action.payload.kanbanSessionContextVersion,
			boardSyncStatus: null,
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
	if (action.type === "workspace_state_updated") {
		const mergedWorkspaceState = {
			...action.workspaceState,
			sessions: mergeTaskSessionSummaries(
				state.workspaceState?.sessions ?? {},
				Object.values(action.workspaceState.sessions ?? {}),
			),
		};
		return {
			...state,
			workspaceState: mergedWorkspaceState,
		};
	}
	if (action.type === "task_sessions_updated") {
		if (!state.workspaceState) {
			return state;
		}
		return {
			...state,
			workspaceState: {
				...state.workspaceState,
				sessions: mergeTaskSessionSummaries(state.workspaceState.sessions, action.summaries),
			},
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
}

/** Non-reactive snapshot read — for tests and imperative call sites. */
export function getRuntimeStreamStore(): RuntimeStateStreamStore {
	return store;
}

/** Test-only: reset the singleton and drop all listeners. */
export function resetRuntimeStreamStoreForTest(): void {
	store = createInitialRuntimeStateStreamStore(null);
	for (const key of FIELD_KEYS) {
		fieldListeners[key].clear();
	}
	taskChatListenersByTaskId.clear();
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
