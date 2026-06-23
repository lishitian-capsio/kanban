import { randomUUID } from "node:crypto";

import type {
	RuntimeAgentId,
	RuntimeHomeChatThread,
	RuntimeHomeChatThreadsData,
	RuntimeTaskOrigin,
} from "../core/api-contract";
import { createHomeAgentSessionId } from "../core/home-agent-session";
import { loadWorkspaceHomeThreads, mutateWorkspaceHomeThreads } from "../state/workspace-state";
import {
	closeHomeThread,
	createHomeThread,
	decideAskThread,
	listHomeThreads,
	renameHomeThread,
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
}

export interface ResolveTaskThreadRequest {
	/** The originating home thread recorded on the task, if any. */
	origin?: RuntimeTaskOrigin | null;
	/** Agent for a freshly created fallback thread when the origin can't be reused. */
	fallbackAgentId: RuntimeAgentId;
	/** Name for a freshly created fallback thread (typically references the task). */
	fallbackName: string;
}

export interface ResolveTaskThreadResult {
	/** The home agent session id to attach/inject the "Ask" question into. */
	sessionId: string;
	agentId: RuntimeAgentId;
	threadId: string;
	/** True when a fresh fallback thread was created to satisfy the request. */
	created: boolean;
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

	async create(request: CreateThreadRequest): Promise<RuntimeHomeChatThread> {
		const id = this.generateId();
		const now = this.now();
		await this.persistence.mutate((current) =>
			createHomeThread(current, { id, agentId: request.agentId, name: request.name, now }),
		);
		return {
			id,
			agentId: request.agentId,
			name: request.name,
			createdAt: now,
			updatedAt: now,
		};
	}

	/**
	 * Resolve where a task's "Ask" review question should be routed: the home
	 * agent session id of the originating thread when it still exists, otherwise a
	 * freshly created thread bound to the task. Backs the reverse task → kanban
	 * agent association the "Ask" action depends on.
	 *
	 * A closed/absent origin falls back to a new thread bound to the original
	 * kanban agent (so the user keeps talking to the agent that created the task),
	 * falling through to the workspace default agent only when no origin exists.
	 */
	async resolveTaskThread(request: ResolveTaskThreadRequest): Promise<ResolveTaskThreadResult> {
		const data = await this.persistence.load();
		const decision = decideAskThread({ origin: request.origin, threads: data.threads });
		if (decision.kind === "existing") {
			return {
				sessionId: createHomeAgentSessionId(this.workspaceId, decision.agentId, decision.threadId),
				agentId: decision.agentId,
				threadId: decision.threadId,
				created: false,
			};
		}
		const agentId = request.origin?.agentId ?? request.fallbackAgentId;
		const thread = await this.create({ agentId, name: request.fallbackName });
		return {
			sessionId: createHomeAgentSessionId(this.workspaceId, thread.agentId, thread.id),
			agentId: thread.agentId,
			threadId: thread.id,
			created: true,
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
