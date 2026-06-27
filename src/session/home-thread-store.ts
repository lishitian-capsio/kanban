import { randomUUID } from "node:crypto";

import type {
	RuntimeAgentId,
	RuntimeHomeChatFullscreenTabs,
	RuntimeHomeChatThread,
	RuntimeHomeChatThreadsData,
	RuntimeHomeChatThreadTitleSource,
} from "../core/api-contract";
import { createHomeAgentSessionId } from "../core/home-agent-session";
import { loadWorkspaceHomeThreads, mutateWorkspaceHomeThreads } from "../state/workspace-state";
import {
	closeHomeThread,
	createHomeThread,
	getHomeFullscreenTabs,
	listHomeThreads,
	renameHomeThread,
	type SetHomeThreadAutoTitleResult,
	setHomeFullscreenTabs,
	setHomeThreadAutoTitle,
	setHomeThreadNextStep,
} from "./home-thread-registry";

/**
 * Persistence seam for the home chat thread registry. The default
 * implementation is backed by `threads.json` (see
 * {@link createWorkspaceHomeThreadStore}); tests inject an in-memory fake.
 */
export interface HomeThreadPersistence {
	load(): Promise<RuntimeHomeChatThreadsData>;
	mutate(fn: (current: RuntimeHomeChatThreadsData) => RuntimeHomeChatThreadsData): Promise<RuntimeHomeChatThreadsData>;
}

export interface HomeThreadStoreOptions {
	workspaceId: string;
	persistence: HomeThreadPersistence;
	/**
	 * Invoked after a thread is removed from the registry, with the full
	 * synthetic home agent session id, so the caller can stop and clean up the
	 * backing session (process + in-memory entry + persisted transcript). Wired
	 * to the session managers in the workspace registry.
	 */
	onCloseSession?: (sessionId: string) => Promise<void> | void;
	now?: () => number;
	generateId?: () => string;
}

export interface CreateThreadRequest {
	agentId: RuntimeAgentId;
	name: string;
	/** How `name` was set. Defaults to `manual` (pinned) when omitted. */
	titleSource?: RuntimeHomeChatThreadTitleSource;
}

export interface SetAutoTitleResult {
	thread: RuntimeHomeChatThread;
	/** False when the thread's title was pinned `manual` and therefore left untouched. */
	applied: boolean;
}

/**
 * Per-workspace orchestration over the home chat thread registry: composes the
 * pure registry operations (`home-thread-registry.ts`) with persistence and
 * the session-cleanup lifecycle. Exposes async `list`/`create`/`rename`/`close`
 * with no network surface — endpoints are a later layer.
 */
export class HomeThreadStore {
	private readonly workspaceId: string;
	private readonly persistence: HomeThreadPersistence;
	private readonly onCloseSession?: (sessionId: string) => Promise<void> | void;
	private readonly now: () => number;
	private readonly generateId: () => string;

	constructor(options: HomeThreadStoreOptions) {
		this.workspaceId = options.workspaceId;
		this.persistence = options.persistence;
		this.onCloseSession = options.onCloseSession;
		this.now = options.now ?? (() => Date.now());
		this.generateId = options.generateId ?? (() => randomUUID());
	}

	async list(): Promise<RuntimeHomeChatThread[]> {
		return listHomeThreads(await this.persistence.load());
	}

	/** The persisted fullscreen-workspace tab set (open tabs + active tab). */
	async getFullscreenTabs(): Promise<RuntimeHomeChatFullscreenTabs> {
		return getHomeFullscreenTabs(await this.persistence.load());
	}

	/**
	 * Persist a new fullscreen-workspace tab set. The registry sanitizes it against the
	 * current threads (dropping tabs for threads that no longer exist) and skips the
	 * write when nothing changed. Returns the stored set.
	 */
	async setFullscreenTabs(tabs: RuntimeHomeChatFullscreenTabs): Promise<RuntimeHomeChatFullscreenTabs> {
		const next = await this.persistence.mutate((current) => setHomeFullscreenTabs(current, tabs));
		return getHomeFullscreenTabs(next);
	}

	async create(request: CreateThreadRequest): Promise<RuntimeHomeChatThread> {
		const id = this.generateId();
		const now = this.now();
		const titleSource = request.titleSource ?? "manual";
		await this.persistence.mutate((current) =>
			createHomeThread(current, { id, agentId: request.agentId, name: request.name, titleSource, now }),
		);
		return {
			id,
			agentId: request.agentId,
			name: request.name,
			titleSource,
			createdAt: now,
			updatedAt: now,
		};
	}

	async rename(id: string, name: string): Promise<RuntimeHomeChatThread> {
		const now = this.now();
		const next = await this.persistence.mutate((current) => renameHomeThread(current, id, name, now));
		const renamed = next.threads.find((thread) => thread.id === id);
		if (!renamed) {
			// Unreachable: renameHomeThread throws when the id is missing.
			throw new Error(`Home chat thread "${id}" not found after rename.`);
		}
		return renamed;
	}

	/**
	 * Set a thread's title from its own agent (`home-thread set-title`). Records the title
	 * as `auto`, but leaves a pinned `manual` title untouched (`applied: false`) so a user
	 * rename always wins. Throws if the thread is missing.
	 */
	async setAutoTitle(id: string, title: string): Promise<SetAutoTitleResult> {
		const now = this.now();
		let result: SetHomeThreadAutoTitleResult | undefined;
		await this.persistence.mutate((current) => {
			result = setHomeThreadAutoTitle(current, id, title, now);
			return result.next;
		});
		if (!result) {
			// Unreachable: setHomeThreadAutoTitle throws when the id is missing.
			throw new Error(`Home chat thread "${id}" not found.`);
		}
		return { thread: result.thread, applied: result.applied };
	}

	/**
	 * Set or clear a thread's transient `pendingNextStep` suggestion. Pass a non-empty string
	 * to record the agent's proposed next step (`home-thread suggest-next`), or `null` to clear
	 * it (done when the user sends a message in the thread). Returns the updated thread. Throws
	 * if the thread is missing.
	 */
	async setNextStep(id: string, suggestion: string | null): Promise<RuntimeHomeChatThread> {
		const next = await this.persistence.mutate((current) => setHomeThreadNextStep(current, id, suggestion));
		const updated = next.threads.find((thread) => thread.id === id);
		if (!updated) {
			// Unreachable: setHomeThreadNextStep throws when the id is missing.
			throw new Error(`Home chat thread "${id}" not found after setNextStep.`);
		}
		return updated;
	}

	async close(id: string): Promise<RuntimeHomeChatThread> {
		let removed: RuntimeHomeChatThread | undefined;
		await this.persistence.mutate((current) => {
			const result = closeHomeThread(current, id);
			removed = result.removed;
			return result.next;
		});
		if (!removed) {
			// Unreachable: closeHomeThread throws when the id is missing.
			throw new Error(`Home chat thread "${id}" not found.`);
		}
		const sessionId = createHomeAgentSessionId(this.workspaceId, removed.agentId, removed.id);
		await this.onCloseSession?.(sessionId);
		return removed;
	}
}

export interface CreateWorkspaceHomeThreadStoreOptions {
	onCloseSession?: (sessionId: string) => Promise<void> | void;
}

/** Build a `threads.json`-backed store for a workspace. */
export function createWorkspaceHomeThreadStore(
	workspaceId: string,
	options: CreateWorkspaceHomeThreadStoreOptions = {},
): HomeThreadStore {
	return new HomeThreadStore({
		workspaceId,
		persistence: {
			load: () => loadWorkspaceHomeThreads(workspaceId),
			mutate: (fn) => mutateWorkspaceHomeThreads(workspaceId, fn),
		},
		onCloseSession: options.onCloseSession,
	});
}
