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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeHomeChatThread } from "@/runtime/types";

const DEFAULT_THREAD_NAME = "Default";

// The initial registry load can fail transiently on restart (the workspace scope
// is briefly unresolvable while the runtime finishes its boot migrations/locks,
// or auth is not yet established in --host/passcode mode). The threads are safe
// server-side, so retry a bounded number of times with a small linear backoff
// rather than giving up and hiding every thread behind the synthetic Default.
const HOME_THREADS_LOAD_RETRY_BASE_DELAY_MS = 500;
const HOME_THREADS_LOAD_MAX_ATTEMPTS = 5;

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
	createThread: (input: { name: string; agentId: RuntimeAgentId }) => Promise<HomeThread | null>;
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
	const [loadRetryNonce, setLoadRetryNonce] = useState(0);
	// Tracks workspaces whose registry load *succeeded*. Using this (instead of the
	// presence of a `registryThreadsByWorkspace` entry) as the load guard is the
	// crux of the fix: a failed load no longer writes a poisoning empty entry that
	// would mask every persisted thread until a full reload.
	const loadedWorkspacesRef = useRef<Set<string>>(new Set());
	const loadAttemptsRef = useRef<Map<string, number>>(new Map());

	const selectedAgentId = runtimeProjectConfig?.selectedAgentId ?? null;

	// Load the registry threads once per workspace (with bounded retry on transient
	// failure) whenever the workspace becomes available.
	useEffect(() => {
		if (!currentProjectId || !runtimeProjectConfig) {
			return;
		}
		if (loadedWorkspacesRef.current.has(currentProjectId)) {
			return;
		}
		const workspaceId = currentProjectId;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		setLoadingWorkspaceId(workspaceId);
		void getRuntimeTrpcClient(workspaceId)
			.runtime.listHomeThreads.query()
			.then((response) => {
				if (cancelled) {
					return;
				}
				if (!response.ok) {
					throw new Error(response.error ?? "Could not load home chat threads.");
				}
				loadedWorkspacesRef.current.add(workspaceId);
				loadAttemptsRef.current.delete(workspaceId);
				setRegistryThreadsByWorkspace((current) => ({
					...current,
					[workspaceId]: response.threads,
				}));
			})
			.catch((error) => {
				if (cancelled) {
					return;
				}
				notifyError(error instanceof Error ? error.message : String(error));
				// Do NOT cache an empty list: the threads still exist server-side.
				// Schedule a bounded retry so a transient boot/auth failure self-heals
				// instead of permanently hiding every thread behind the Default.
				const attempts = (loadAttemptsRef.current.get(workspaceId) ?? 0) + 1;
				loadAttemptsRef.current.set(workspaceId, attempts);
				if (attempts < HOME_THREADS_LOAD_MAX_ATTEMPTS) {
					retryTimer = setTimeout(() => {
						setLoadRetryNonce((nonce) => nonce + 1);
					}, HOME_THREADS_LOAD_RETRY_BASE_DELAY_MS * attempts);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoadingWorkspaceId((current) => (current === workspaceId ? null : current));
				}
			});
		return () => {
			cancelled = true;
			if (retryTimer) {
				clearTimeout(retryTimer);
			}
		};
	}, [currentProjectId, runtimeProjectConfig, loadRetryNonce]);

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
		async ({ name, agentId }: { name: string; agentId: RuntimeAgentId }): Promise<HomeThread | null> => {
			if (!currentProjectId) {
				return null;
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
				return { ...created, isDefault: false };
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
				return null;
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
