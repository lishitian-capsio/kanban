// Owns the per-workspace home chat thread list for the sidebar agent panel.
//
// The home agent can host several parallel conversations ("threads"), each with
// its own agent (pi/claude/codex/...). Threads are persisted server-side in the
// per-workspace registry and reached through the `runtime.*HomeThread` tRPC
// endpoints. This hook exposes the list plus the currently active thread and the
// create/rename/close mutations the thread switcher drives.
//
// Backward compatibility: existing workspaces have no registry entries, so a
// synthetic "Default" thread is always prepended. Its id is the reserved
// DEFAULT_HOME_THREAD_ID, which `createHomeAgentSessionId` maps back to the
// legacy three-segment session id — so the historical single home chat keeps its
// transcript with no migration. The default thread's agent follows the
// workspace-global selection (Settings still flips it between pi-chat and
// terminal); registry threads carry a fixed agent chosen at creation.

import { DEFAULT_HOME_THREAD_ID } from "@runtime-home-agent-session";
import { useCallback, useEffect, useMemo, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeHomeChatThread } from "@/runtime/types";

const DEFAULT_THREAD_NAME = "Default";

export interface HomeThread extends RuntimeHomeChatThread {
	/** True for the synthetic default thread (not a registry entry; not renamable/closable). */
	isDefault: boolean;
}

interface UseHomeThreadsInput {
	currentProjectId: string | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
}

export interface UseHomeThreadsResult {
	threads: HomeThread[];
	activeThread: HomeThread | null;
	activeThreadId: string;
	setActiveThread: (threadId: string) => void;
	createThread: (input: { name: string; agentId: RuntimeAgentId }) => Promise<void>;
	renameThread: (threadId: string, name: string) => Promise<void>;
	closeThread: (threadId: string) => Promise<void>;
	isLoading: boolean;
}

function buildDefaultThread(agentId: RuntimeAgentId): HomeThread {
	return {
		id: DEFAULT_HOME_THREAD_ID,
		agentId,
		name: DEFAULT_THREAD_NAME,
		createdAt: 0,
		updatedAt: 0,
		isDefault: true,
	};
}

export function useHomeThreads({ currentProjectId, runtimeProjectConfig }: UseHomeThreadsInput): UseHomeThreadsResult {
	const [registryThreadsByWorkspace, setRegistryThreadsByWorkspace] = useState<
		Record<string, RuntimeHomeChatThread[]>
	>({});
	const [activeThreadIdByWorkspace, setActiveThreadIdByWorkspace] = useState<Record<string, string>>({});
	const [loadingWorkspaceId, setLoadingWorkspaceId] = useState<string | null>(null);

	const selectedAgentId = runtimeProjectConfig?.selectedAgentId ?? null;

	// Load (or reload) the registry threads whenever the workspace becomes available.
	useEffect(() => {
		if (!currentProjectId || !runtimeProjectConfig) {
			return;
		}
		if (registryThreadsByWorkspace[currentProjectId]) {
			return;
		}
		let cancelled = false;
		setLoadingWorkspaceId(currentProjectId);
		void getRuntimeTrpcClient(currentProjectId)
			.runtime.listHomeThreads.query()
			.then((response) => {
				if (cancelled) {
					return;
				}
				if (!response.ok) {
					throw new Error(response.error ?? "Could not load home chat threads.");
				}
				setRegistryThreadsByWorkspace((current) => ({
					...current,
					[currentProjectId]: response.threads,
				}));
			})
			.catch((error) => {
				if (cancelled) {
					return;
				}
				notifyError(error instanceof Error ? error.message : String(error));
				setRegistryThreadsByWorkspace((current) => ({
					...current,
					[currentProjectId]: [],
				}));
			})
			.finally(() => {
				if (!cancelled) {
					setLoadingWorkspaceId((current) => (current === currentProjectId ? null : current));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [currentProjectId, runtimeProjectConfig, registryThreadsByWorkspace]);

	const threads = useMemo<HomeThread[]>(() => {
		if (!currentProjectId || !selectedAgentId) {
			return [];
		}
		const registry = registryThreadsByWorkspace[currentProjectId] ?? [];
		const nonDefault = registry
			.filter((thread) => thread.id !== DEFAULT_HOME_THREAD_ID)
			.map<HomeThread>((thread) => ({ ...thread, isDefault: false }));
		return [buildDefaultThread(selectedAgentId), ...nonDefault];
	}, [currentProjectId, registryThreadsByWorkspace, selectedAgentId]);

	const activeThreadId = currentProjectId
		? (activeThreadIdByWorkspace[currentProjectId] ?? DEFAULT_HOME_THREAD_ID)
		: DEFAULT_HOME_THREAD_ID;

	// The active id may point at a thread that was closed (here or elsewhere);
	// fall back to the default thread when it is no longer present.
	const activeThread = useMemo<HomeThread | null>(() => {
		if (threads.length === 0) {
			return null;
		}
		return threads.find((thread) => thread.id === activeThreadId) ?? threads[0] ?? null;
	}, [threads, activeThreadId]);

	const setActiveThread = useCallback(
		(threadId: string) => {
			if (!currentProjectId) {
				return;
			}
			setActiveThreadIdByWorkspace((current) => ({ ...current, [currentProjectId]: threadId }));
		},
		[currentProjectId],
	);

	const createThread = useCallback(
		async ({ name, agentId }: { name: string; agentId: RuntimeAgentId }) => {
			if (!currentProjectId) {
				return;
			}
			try {
				const response = await getRuntimeTrpcClient(currentProjectId).runtime.createHomeThread.mutate({
					name,
					agentId,
				});
				if (!response.ok || !response.thread) {
					throw new Error(response.error ?? "Could not create home chat thread.");
				}
				const created = response.thread;
				setRegistryThreadsByWorkspace((current) => ({
					...current,
					[currentProjectId]: [...(current[currentProjectId] ?? []), created],
				}));
				setActiveThreadIdByWorkspace((current) => ({ ...current, [currentProjectId]: created.id }));
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			}
		},
		[currentProjectId],
	);

	const renameThread = useCallback(
		async (threadId: string, name: string) => {
			if (!currentProjectId || threadId === DEFAULT_HOME_THREAD_ID) {
				return;
			}
			try {
				const response = await getRuntimeTrpcClient(currentProjectId).runtime.renameHomeThread.mutate({
					id: threadId,
					name,
				});
				if (!response.ok || !response.thread) {
					throw new Error(response.error ?? "Could not rename home chat thread.");
				}
				const renamed = response.thread;
				setRegistryThreadsByWorkspace((current) => ({
					...current,
					[currentProjectId]: (current[currentProjectId] ?? []).map((thread) =>
						thread.id === renamed.id ? renamed : thread,
					),
				}));
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			}
		},
		[currentProjectId],
	);

	const closeThread = useCallback(
		async (threadId: string) => {
			if (!currentProjectId || threadId === DEFAULT_HOME_THREAD_ID) {
				return;
			}
			try {
				const response = await getRuntimeTrpcClient(currentProjectId).runtime.closeHomeThread.mutate({
					id: threadId,
				});
				if (!response.ok) {
					throw new Error(response.error ?? "Could not close home chat thread.");
				}
				setRegistryThreadsByWorkspace((current) => ({
					...current,
					[currentProjectId]: (current[currentProjectId] ?? []).filter((thread) => thread.id !== threadId),
				}));
				setActiveThreadIdByWorkspace((current) => {
					if (current[currentProjectId] !== threadId) {
						return current;
					}
					return { ...current, [currentProjectId]: DEFAULT_HOME_THREAD_ID };
				});
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			}
		},
		[currentProjectId],
	);

	return {
		threads,
		activeThread,
		activeThreadId: activeThread?.id ?? DEFAULT_HOME_THREAD_ID,
		setActiveThread,
		createThread,
		renameThread,
		closeThread,
		isLoading: loadingWorkspaceId !== null && loadingWorkspaceId === currentProjectId,
	};
}
