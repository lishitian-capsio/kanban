// Reloads an active pi chat session in place when the runtime bumps the Kanban
// session-context version (MCP settings/auth changed). The session keeps the same
// task id and transcript but restarts with a fresh MCP tool bundle.
//
// Shared by the single Pi area (PiConversationSurface) and the CLI-only home session
// hook (use-home-agent-session), so the reload semantics stay in one place. The
// per-workspace "previous version" bookkeeping lives here.
import { useEffect, useRef } from "react";

import { notifyError } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

interface UseReloadPiSessionOnContextBumpInput {
	workspaceId: string | null;
	taskId: string | null;
	/** Only reload when this surface is the active pi chat. */
	active: boolean;
	/** Only reload when a session already exists (nothing to reload otherwise). */
	hasSession: boolean;
	kanbanSessionContextVersion: number;
	onSummary: (summary: RuntimeTaskSessionSummary) => void;
}

export function useReloadPiSessionOnContextBump({
	workspaceId,
	taskId,
	active,
	hasSession,
	kanbanSessionContextVersion,
	onSummary,
}: UseReloadPiSessionOnContextBumpInput): void {
	const previousVersionByWorkspaceRef = useRef(new Map<string, number>());
	const disposedRef = useRef(false);
	useEffect(() => {
		return () => {
			disposedRef.current = true;
		};
	}, []);

	useEffect(() => {
		if (!workspaceId || !active || !taskId) {
			return;
		}

		const previousVersion = previousVersionByWorkspaceRef.current.get(workspaceId);
		previousVersionByWorkspaceRef.current.set(workspaceId, kanbanSessionContextVersion);

		if (previousVersion === undefined || previousVersion === kanbanSessionContextVersion) {
			return;
		}
		if (!hasSession) {
			return;
		}

		let cancelled = false;
		void getRuntimeTrpcClient(workspaceId)
			.runtime.reloadTaskChatSession.mutate({ taskId })
			.then((response) => {
				if (cancelled || disposedRef.current) {
					return;
				}
				if (!response.ok || !response.summary) {
					throw new Error(response.error ?? "Could not reload home agent session.");
				}
				onSummary(response.summary);
			})
			.catch((error) => {
				if (cancelled || disposedRef.current) {
					return;
				}
				notifyError(error instanceof Error ? error.message : String(error));
			});

		return () => {
			cancelled = true;
		};
	}, [kanbanSessionContextVersion, workspaceId, active, taskId, hasSession, onSummary]);
}
