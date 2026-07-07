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
import {
	activateHomeTab as activateHomeTabOp,
	closeSessionTab as closeSessionTabOp,
	type FullscreenTabsState,
	openSessionTab as openSessionTabOp,
	reconcileOnEnterFullscreen,
	setActiveSessionTab as setActiveSessionTabOp,
} from "@/components/home-agent/home-fullscreen-tabs";
import { isNativeAgentSelected } from "@/runtime/native-agent";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentId,
	RuntimeConfigResponse,
	RuntimeHomeChatThread,
	RuntimeHomeChatThreadBindImChannelRequest,
} from "@/runtime/types";
import type { TaskImage } from "@/types";

type ImChannelTarget = RuntimeHomeChatThreadBindImChannelRequest["channel"];

function sameImChannel(a: ImChannelTarget, b: ImChannelTarget): boolean {
	return a.platform === b.platform && a.chatId === b.chatId;
}

/**
 * One-to-one local mirror of the backend's exclusive bind: after a thread binds `channel`,
 * clear that same channel off every OTHER thread in the list so the UI matches the server
 * (an IM chat maps to at most one thread — requirement ac99c, 159ab). Returns a new array.
 */
function clearImChannelFromOtherThreads(
	list: RuntimeHomeChatThread[],
	boundThreadId: string,
	channel: ImChannelTarget,
): RuntimeHomeChatThread[] {
	return list.map((thread) =>
		thread.id !== boundThreadId && thread.imChannel && sameImChannel(thread.imChannel, channel)
			? { ...thread, imChannel: null }
			: thread,
	);
}

const DEFAULT_THREAD_NAME = "Default";
const EMPTY_FULLSCREEN_TABS: FullscreenTabsState = { openThreadIds: [], activeThreadId: null };

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
	/**
	 * Create a thread. With a `description` it kicks off the thread's first turn (and seeds a
	 * provisional `auto` title); with only a `name` it creates a blank session (no kickoff) — the
	 * Pi tab's "New session" uses the latter. Resolves to the new thread id, or null on failure.
	 */
	createThread: (input: {
		description?: string;
		name?: string;
		agentId: RuntimeAgentId;
		images?: TaskImage[];
		/** Optional IM channel to bind to the new thread (best-effort, after create). */
		imChannel?: ImChannelTarget | null;
	}) => Promise<string | null>;
	renameThread: (threadId: string, name: string) => Promise<void>;
	closeThread: (threadId: string) => Promise<void>;
	/** Bind an IM channel to an existing thread (no-op for the synthetic default). */
	bindThreadImChannel: (threadId: string, channel: ImChannelTarget) => Promise<void>;
	/** Remove a thread's IM channel binding. */
	unbindThreadImChannel: (threadId: string) => Promise<void>;
	/**
	 * Optimistically clear a thread's pending next-step suggestion locally (drop the chip the
	 * instant the user sends a message). The runtime also clears it server-side on send and
	 * broadcasts a session-context bump, so a subsequent {@link refresh} reconciles either way.
	 */
	clearNextStep: (threadId: string) => void;
	/**
	 * Re-fetch the registry for the current workspace. Used to pick up agent-driven
	 * title changes (a thread self-titles via `home-thread set-title`, which bumps the
	 * kanban session-context version); a background refresh, so failures are silent.
	 */
	refresh: () => Promise<void>;
	isLoading: boolean;
	/**
	 * The persisted fullscreen-workspace tab set for the current workspace: which threads are
	 * open as session tabs and which tab is active (`activeThreadId === null` ⇒ the Home tab /
	 * launcher). Drives the fullscreen Home-tab/session-tab layout (decision 1902b). The mutations
	 * below apply the pure tab transitions optimistically and persist to the registry best-effort.
	 */
	fullscreenTabs: FullscreenTabsState;
	/** Open (or focus) a session tab for the thread and make it active. */
	openSessionTab: (threadId: string) => void;
	/** Close a session tab — UI-only collapse back to Home; never a thread hard-close. */
	closeSessionTab: (threadId: string) => void;
	/** Activate an already-open session tab. */
	activateSessionTab: (threadId: string) => void;
	/** Activate the Home tab (the launcher), keeping the open session tabs intact. */
	activateHomeTab: () => void;
	/**
	 * Continuity rule for entering fullscreen: restore the persisted tab set, seeding the current
	 * docked conversation as the first tab when nothing is persisted yet. Run once when the
	 * fullscreen workspace mounts.
	 */
	reconcileFullscreenTabsOnEnter: () => void;
}

function buildDefaultThread(agentId: RuntimeAgentId): HomeThread {
	return {
		id: DEFAULT_HOME_THREAD_ID,
		agentId,
		name: DEFAULT_THREAD_NAME,
		// The default thread's label is a fixed frontend constant, never agent-managed.
		titleSource: "manual",
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
	const [fullscreenTabsByWorkspace, setFullscreenTabsByWorkspace] = useState<Record<string, FullscreenTabsState>>({});
	// Mirror of fullscreenTabsByWorkspace read synchronously inside the tab mutations so
	// rapid successive actions compose off the latest value (not the render-lagged state).
	const fullscreenTabsRef = useRef<Record<string, FullscreenTabsState>>({});
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
				const loadedTabs = response.fullscreenTabs ?? EMPTY_FULLSCREEN_TABS;
				fullscreenTabsRef.current = { ...fullscreenTabsRef.current, [workspaceId]: loadedTabs };
				setFullscreenTabsByWorkspace((current) => ({ ...current, [workspaceId]: loadedTabs }));
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

	// The thread list is CLI-agent only (decision 647ea / X1): Pi is not a switchable
	// "thread" — it is its own single embedded area (PiConversationSurface), so it never
	// appears here. Two consequences: (a) the synthetic default thread is only synthesized
	// when the workspace-global agent is a CLI agent (when it is Pi, the Sessions side has no
	// default — the Pi area covers it); (b) any legacy pi-bound registry thread (4-segment id
	// created by the retired multi-Pi-session UI) is filtered out. Its transcript remains on
	// disk, just unsurfaced.
	const threads = useMemo<HomeThread[]>(() => {
		if (!currentProjectId || !selectedAgentId) {
			return [];
		}
		const registry = registryThreadsByWorkspace[currentProjectId] ?? [];
		const nonDefault = registry
			.filter((thread) => thread.id !== DEFAULT_HOME_THREAD_ID && !isNativeAgentSelected(thread.agentId))
			.map<HomeThread>((thread) => ({ ...thread, isDefault: false }));
		const withoutDefault = isNativeAgentSelected(selectedAgentId);
		return withoutDefault ? nonDefault : [buildDefaultThread(selectedAgentId), ...nonDefault];
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
		async ({
			threadId,
			description,
			name,
			agentId,
			images,
			imChannel,
		}: {
			/**
			 * Optional client-generated thread id. The create dialog mints it up front so
			 * pre-session attachments upload into the thread's final attachments scope; the
			 * created thread adopts this id. Omit for name-only / programmatic creates.
			 */
			threadId?: string;
			description?: string;
			name?: string;
			agentId: RuntimeAgentId;
			images?: TaskImage[];
			imChannel?: ImChannelTarget | null;
		}): Promise<string | null> => {
			if (!currentProjectId) {
				return null;
			}
			try {
				// `description` becomes the thread's kickoff prompt and the seed for a provisional
				// title; the thread's own agent self-titles it shortly after its first turn. A
				// `name`-only create makes a blank session (no kickoff) — the backend requires at
				// least one of the two. `images` (pasted/dragged into the create dialog) ride along
				// with the kickoff prompt so the agent's first turn sees them.
				const response = await getRuntimeTrpcClient(currentProjectId).runtime.createHomeThread.mutate({
					...(threadId ? { id: threadId } : {}),
					description,
					name,
					agentId,
					images,
				});
				if (!response.ok || !response.thread) {
					throw new Error(response.error ?? "Could not create home chat thread.");
				}
				const created = response.thread;
				let finalThread = created;
				// Best-effort bind AFTER create — keeps T4's createHomeThread contract untouched.
				// A bind failure never fails the create: the thread exists (rebind via kebab).
				// Both resolved {ok:false} and thrown errors are caught here so neither shape
				// rolls back the create (spec: "绑定失败不回滚会话创建").
				if (imChannel) {
					try {
						const bindResponse = await getRuntimeTrpcClient(
							currentProjectId,
						).runtime.bindHomeThreadImChannel.mutate({ id: created.id, channel: imChannel });
						if (bindResponse.ok && bindResponse.thread) {
							finalThread = bindResponse.thread;
						} else {
							notifyError(bindResponse.error ?? "Could not bind IM channel.");
						}
					} catch (error) {
						notifyError(error instanceof Error ? error.message : String(error));
					}
				}
				setRegistryThreadsByWorkspace((current) => {
					const existing = current[currentProjectId] ?? [];
					// One-to-one: if the new thread adopted a channel another thread held, drop it there.
					const reconciled = finalThread.imChannel
						? clearImChannelFromOtherThreads(existing, finalThread.id, finalThread.imChannel)
						: existing;
					return { ...current, [currentProjectId]: [...reconciled, finalThread] };
				});
				setActiveThreadIdByWorkspace((current) => ({ ...current, [currentProjectId]: finalThread.id }));
				return finalThread.id;
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

	const clearNextStep = useCallback(
		(threadId: string) => {
			if (!currentProjectId || threadId === DEFAULT_HOME_THREAD_ID) {
				return;
			}
			setRegistryThreadsByWorkspace((current) => {
				const threadsForWorkspace = current[currentProjectId];
				if (!threadsForWorkspace?.some((thread) => thread.id === threadId && thread.pendingNextStep)) {
					return current;
				}
				return {
					...current,
					[currentProjectId]: threadsForWorkspace.map((thread) =>
						thread.id === threadId ? { ...thread, pendingNextStep: null } : thread,
					),
				};
			});
		},
		[currentProjectId],
	);

	const refresh = useCallback(async () => {
		if (!currentProjectId) {
			return;
		}
		const workspaceId = currentProjectId;
		try {
			const response = await getRuntimeTrpcClient(workspaceId).runtime.listHomeThreads.query();
			if (!response.ok) {
				return;
			}
			loadedWorkspacesRef.current.add(workspaceId);
			setRegistryThreadsByWorkspace((current) => ({
				...current,
				[workspaceId]: response.threads,
			}));
			const refreshedTabs = response.fullscreenTabs ?? EMPTY_FULLSCREEN_TABS;
			fullscreenTabsRef.current = { ...fullscreenTabsRef.current, [workspaceId]: refreshedTabs };
			setFullscreenTabsByWorkspace((current) => ({ ...current, [workspaceId]: refreshedTabs }));
		} catch {
			// Background refresh: a transient failure is non-fatal. The persisted threads
			// are intact server-side and the next session-context bump retries; never
			// poison the cache with an empty list (see the initial-load guard above).
		}
	}, [currentProjectId]);

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
				// The runtime's closeHomeThread already pruned this thread from the persisted tab set;
				// mirror that locally (no extra persist) so a hard-closed thread can't linger as a tab.
				const previousTabs = fullscreenTabsRef.current[currentProjectId] ?? EMPTY_FULLSCREEN_TABS;
				const prunedTabs = closeSessionTabOp(previousTabs, threadId);
				if (prunedTabs !== previousTabs) {
					fullscreenTabsRef.current = { ...fullscreenTabsRef.current, [currentProjectId]: prunedTabs };
					setFullscreenTabsByWorkspace((current) => ({ ...current, [currentProjectId]: prunedTabs }));
				}
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			}
		},
		[currentProjectId],
	);

	const bindThreadImChannel = useCallback(
		async (threadId: string, channel: ImChannelTarget) => {
			if (!currentProjectId || threadId === DEFAULT_HOME_THREAD_ID) {
				return;
			}
			try {
				const response = await getRuntimeTrpcClient(currentProjectId).runtime.bindHomeThreadImChannel.mutate({
					id: threadId,
					channel,
				});
				if (!response.ok || !response.thread) {
					throw new Error(response.error ?? "Could not bind IM channel.");
				}
				const bound = response.thread;
				setRegistryThreadsByWorkspace((current) => {
					const updated = (current[currentProjectId] ?? []).map((thread) =>
						thread.id === bound.id ? bound : thread,
					);
					// One-to-one: mirror the backend's exclusive bind by clearing the same channel
					// off any other thread that held it (so the old thread's chip drops immediately).
					const reconciled = bound.imChannel
						? clearImChannelFromOtherThreads(updated, bound.id, bound.imChannel)
						: updated;
					return { ...current, [currentProjectId]: reconciled };
				});
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			}
		},
		[currentProjectId],
	);

	const unbindThreadImChannel = useCallback(
		async (threadId: string) => {
			if (!currentProjectId || threadId === DEFAULT_HOME_THREAD_ID) {
				return;
			}
			try {
				const response = await getRuntimeTrpcClient(currentProjectId).runtime.unbindHomeThreadImChannel.mutate({
					id: threadId,
				});
				if (!response.ok || !response.thread) {
					throw new Error(response.error ?? "Could not unbind IM channel.");
				}
				const unbound = response.thread;
				setRegistryThreadsByWorkspace((current) => ({
					...current,
					[currentProjectId]: (current[currentProjectId] ?? []).map((thread) =>
						thread.id === unbound.id ? unbound : thread,
					),
				}));
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			}
		},
		[currentProjectId],
	);

	const fullscreenTabs = currentProjectId
		? (fullscreenTabsByWorkspace[currentProjectId] ?? EMPTY_FULLSCREEN_TABS)
		: EMPTY_FULLSCREEN_TABS;

	// Apply a pure tab transition optimistically, then persist the result to the registry
	// best-effort. The ref mirror keeps successive calls composing off the latest value.
	const applyFullscreenTabs = useCallback(
		(transform: (current: FullscreenTabsState) => FullscreenTabsState) => {
			if (!currentProjectId) {
				return;
			}
			const workspaceId = currentProjectId;
			const previous = fullscreenTabsRef.current[workspaceId] ?? EMPTY_FULLSCREEN_TABS;
			const next = transform(previous);
			if (next === previous) {
				return;
			}
			fullscreenTabsRef.current = { ...fullscreenTabsRef.current, [workspaceId]: next };
			setFullscreenTabsByWorkspace((current) => ({ ...current, [workspaceId]: next }));
			void getRuntimeTrpcClient(workspaceId)
				.runtime.setHomeFullscreenTabs.mutate(next)
				.catch(() => {
					// View state — a failed persist is non-fatal. The optimistic local value stands for
					// this session; the next load reconciles from whatever did persist.
				});
		},
		[currentProjectId],
	);

	const openSessionTab = useCallback(
		(threadId: string) => applyFullscreenTabs((current) => openSessionTabOp(current, threadId)),
		[applyFullscreenTabs],
	);
	const closeSessionTab = useCallback(
		(threadId: string) => applyFullscreenTabs((current) => closeSessionTabOp(current, threadId)),
		[applyFullscreenTabs],
	);
	const activateSessionTab = useCallback(
		(threadId: string) => applyFullscreenTabs((current) => setActiveSessionTabOp(current, threadId)),
		[applyFullscreenTabs],
	);
	const activateHomeTab = useCallback(
		() => applyFullscreenTabs((current) => activateHomeTabOp(current)),
		[applyFullscreenTabs],
	);

	// The fullscreen workspace never exposes the synthetic default thread, so entering
	// fullscreen while the docked default chat is active seeds the Home launcher (null), not a
	// stale "default" session tab. Created threads still seed their own tab on enter.
	const seedActiveThreadId = activeThread && !activeThread.isDefault ? activeThread.id : null;
	const reconcileFullscreenTabsOnEnter = useCallback(
		() => applyFullscreenTabs((current) => reconcileOnEnterFullscreen(current, seedActiveThreadId)),
		[applyFullscreenTabs, seedActiveThreadId],
	);

	return {
		threads,
		activeThread,
		activeThreadId: activeThread?.id ?? DEFAULT_HOME_THREAD_ID,
		setActiveThread,
		createThread,
		renameThread,
		closeThread,
		bindThreadImChannel,
		unbindThreadImChannel,
		clearNextStep,
		refresh,
		isLoading: loadingWorkspaceId !== null && loadingWorkspaceId === currentProjectId,
		fullscreenTabs,
		openSessionTab,
		closeSessionTab,
		activateSessionTab,
		activateHomeTab,
		reconcileFullscreenTabsOnEnter,
	};
}
