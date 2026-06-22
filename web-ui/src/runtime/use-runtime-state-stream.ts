import { useEffect, useRef } from "react";

import { dispatchRuntimeStreamAction, resolveProjectIdAfterProjectsUpdate } from "@/runtime/runtime-stream-store";
import type { RuntimeStateStreamMessage } from "@/runtime/types";

const STREAM_RECONNECT_BASE_DELAY_MS = 500;
const STREAM_RECONNECT_MAX_DELAY_MS = 5_000;

function getRuntimeStreamUrl(workspaceId: string | null): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/runtime/ws`);
	if (workspaceId) {
		url.searchParams.set("workspaceId", workspaceId);
	}
	return url.toString();
}

/**
 * Drives the runtime state-stream WebSocket connection (open / reconnect /
 * route messages) and folds every message into the shared
 * {@link dispatchRuntimeStreamAction} store. It returns nothing: consumers read
 * the state through the granular selector hooks in `runtime-stream-store.ts`
 * (`useRuntimeProjects`, `useTaskChatMessages`, …) so a single channel's update
 * only wakes the components subscribed to that slice — not the whole tree.
 *
 * This hook must be mounted exactly once (it owns the singleton connection).
 */
export function useRuntimeStreamConnection(requestedWorkspaceId: string | null): void {
	const isFirstRunRef = useRef(true);
	useEffect(() => {
		let cancelled = false;
		let socket: WebSocket | null = null;
		let reconnectTimer: number | null = null;
		let reconnectAttempt = 0;
		let activeWorkspaceId = requestedWorkspaceId;
		let requestedWorkspaceForConnection = requestedWorkspaceId;

		if (isFirstRunRef.current) {
			// Seed `currentProjectId` from the URL-derived workspace on first mount
			// (matches the old useReducer init) so we don't flash a "switching"
			// state before the first snapshot arrives.
			isFirstRunRef.current = false;
			dispatchRuntimeStreamAction({ type: "initialize", requestedWorkspaceId });
		} else {
			dispatchRuntimeStreamAction({ type: "requested_workspace_changed" });
		}

		const cleanupSocket = () => {
			if (socket) {
				socket.onopen = null;
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
				socket.close();
				socket = null;
			}
		};

		const scheduleReconnect = () => {
			if (cancelled) {
				return;
			}
			if (reconnectTimer !== null) {
				return;
			}
			const delay = Math.min(STREAM_RECONNECT_MAX_DELAY_MS, STREAM_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt);
			reconnectAttempt += 1;
			reconnectTimer = window.setTimeout(() => {
				connect();
			}, delay);
		};

		const connect = () => {
			if (cancelled) {
				return;
			}
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			cleanupSocket();
			try {
				socket = new WebSocket(getRuntimeStreamUrl(requestedWorkspaceForConnection));
			} catch (error) {
				dispatchRuntimeStreamAction({
					type: "stream_disconnected",
					message: error instanceof Error ? error.message : String(error),
				});
				scheduleReconnect();
				return;
			}
			socket.onopen = () => {
				reconnectAttempt = 0;
				dispatchRuntimeStreamAction({ type: "stream_connected" });
			};
			socket.onmessage = (event) => {
				try {
					const payload = JSON.parse(String(event.data)) as RuntimeStateStreamMessage;
					if (payload.type === "snapshot") {
						activeWorkspaceId = payload.currentProjectId;
						dispatchRuntimeStreamAction({ type: "snapshot", payload });
						return;
					}
					if (payload.type === "projects_updated") {
						const previousWorkspaceId = activeWorkspaceId;
						const nextProjectId = resolveProjectIdAfterProjectsUpdate(activeWorkspaceId, payload);
						activeWorkspaceId = nextProjectId;
						dispatchRuntimeStreamAction({
							type: "projects_updated",
							payload,
							nextProjectId,
						});
						if (nextProjectId && nextProjectId !== previousWorkspaceId) {
							requestedWorkspaceForConnection = nextProjectId;
							dispatchRuntimeStreamAction({ type: "requested_workspace_changed" });
							connect();
						}
						return;
					}
					if (payload.type === "workspace_state_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatchRuntimeStreamAction({
							type: "workspace_state_updated",
							workspaceState: payload.workspaceState,
						});
						return;
					}
					if (payload.type === "workspace_metadata_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatchRuntimeStreamAction({
							type: "workspace_metadata_updated",
							workspaceMetadata: payload.workspaceMetadata,
						});
						return;
					}
					if (payload.type === "task_chat_message") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatchRuntimeStreamAction({
							type: "task_chat_message",
							payload,
						});
						return;
					}
					if (payload.type === "task_chat_cleared") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatchRuntimeStreamAction({
							type: "task_chat_cleared",
							payload,
						});
						return;
					}
					if (payload.type === "task_sessions_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatchRuntimeStreamAction({
							type: "task_sessions_updated",
							summaries: payload.summaries,
						});
						return;
					}
					if (payload.type === "task_ready_for_review") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatchRuntimeStreamAction({
							type: "task_ready_for_review",
							payload,
						});
						return;
					}
					if (payload.type === "mcp_auth_updated") {
						dispatchRuntimeStreamAction({
							type: "mcp_auth_updated",
							payload,
						});
						return;
					}
					if (payload.type === "board_sync_status_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatchRuntimeStreamAction({
							type: "board_sync_status_updated",
							payload,
						});
						return;
					}
					if (payload.type === "kanban_session_context_updated") {
						dispatchRuntimeStreamAction({
							type: "kanban_session_context_updated",
							payload,
						});
						return;
					}
					if (payload.type === "error") {
						dispatchRuntimeStreamAction({
							type: "stream_error",
							message: payload.message,
						});
					}
				} catch {
					// Ignore malformed stream messages.
				}
			};
			socket.onclose = () => {
				if (cancelled) {
					return;
				}
				dispatchRuntimeStreamAction({
					type: "stream_disconnected",
					message: "Runtime stream disconnected.",
				});
				scheduleReconnect();
			};
			socket.onerror = () => {
				if (cancelled) {
					return;
				}
				dispatchRuntimeStreamAction({
					type: "stream_disconnected",
					message: "Runtime stream connection failed.",
				});
			};
		};

		connect();

		return () => {
			cancelled = true;
			if (reconnectTimer != null) {
				window.clearTimeout(reconnectTimer);
			}
			cleanupSocket();
		};
	}, [requestedWorkspaceId]);
}
