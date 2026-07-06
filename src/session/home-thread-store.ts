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

/** A minimal reference to a task that blocks a thread close. */
export interface HomeThreadOpenTask {
	id: string;
	title: string;
}

/**
 * Thrown by {@link HomeThreadStore.close} when the thread still has open
 * (non-terminal) tasks it originated. The hard close is refused so the thread's
 * session/transcript is never destroyed while its work is unfinished.
 */
export class HomeThreadCloseBlockedError extends Error {
	readonly openTasks: HomeThreadOpenTask[];

	constructor(openTasks: HomeThreadOpenTask[]) {
		super(formatBlockedMessage(openTasks));
		this.name = "HomeThreadCloseBlockedError";
		this.openTasks = openTasks;
	}
}

function formatBlockedMessage(openTasks: HomeThreadOpenTask[]): string {
	const count = openTasks.length;
	const noun = count === 1 ? "task" : "tasks";
	const preview = openTasks
		.slice(0, 3)
		.map((task) => `"${task.title}"`)
		.join(", ");
	const suffix = count > 3 ? `, and ${count - 3} more` : "";
	return `Cannot close this thread: it still has ${count} unfinished ${noun} (${preview}${suffix}). Move them to Done first, then close the thread.`;
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
	/**
	 * Returns the open (non-terminal) tasks the thread originated. When this is
	 * provided and returns a non-empty list, {@link HomeThreadStore.close} refuses
	 * the hard close (throws {@link HomeThreadCloseBlockedError}). Injected so the
	 * store stays I/O-free and unit-testable; the runtime wires it to the
	 * workspace board.
	 */
	getOpenOriginTasks?: (threadId: string) => Promise<HomeThreadOpenTask[]> | HomeThreadOpenTask[];
	now?: () => number;
	generateId?: () => string;
}

export interface CreateThreadRequest {
	agentId: RuntimeAgentId;
	name: string;
	/** How `name` was set. Defaults to `manual` (pinned) when omitted. */
	titleSource?: RuntimeHomeChatThreadTitleSource;
	/**
	 * Optional client-supplied thread id. The create dialog generates this up front so
	 * pre-session attachments can be written into the thread's final attachments scope
	 * before the thread exists; the thread then adopts the same id. Omit to mint one.
	 */
	id?: string;
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
	private readonly getOpenOriginTasks?: (threadId: string) => Promise<HomeThreadOpenTask[]> | HomeThreadOpenTask[];
	private readonly now: () => number;
	private readonly generateId: () => string;

	constructor(options: HomeThreadStoreOptions) {
		this.workspaceId = options.workspaceId;
		this.persistence = options.persistence;
		this.onCloseSession = options.onCloseSession;
		this.getOpenOriginTasks = options.getOpenOriginTasks;
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
		const id = request.id ?? this.generateId();
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
		// Refuse a hard close (which stops the process and deletes the transcript)
		// while the thread still has unfinished tasks it originated. The check runs
		// before any mutation so a blocked close leaves the registry and session
		// untouched.
		if (this.getOpenOriginTasks) {
			const openTasks = await this.getOpenOriginTasks(id);
			if (openTasks.length > 0) {
				throw new HomeThreadCloseBlockedError(openTasks);
			}
		}
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
	getOpenOriginTasks?: (threadId: string) => Promise<HomeThreadOpenTask[]> | HomeThreadOpenTask[];
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
		getOpenOriginTasks: options.getOpenOriginTasks,
	});
}
