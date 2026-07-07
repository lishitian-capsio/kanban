import type { RuntimeImChat, RuntimeImChatsData } from "../core/api-contract";
import type { ImPlatform } from "../im/types";
import { loadWorkspaceImChats, mutateWorkspaceImChats } from "../state/workspace-state";
import { listImChats, recordInboundImChat, removeImChat, upsertManualImChat } from "./im-chat-registry";

/**
 * Persistence seam for the per-workspace IM chat list. The default implementation
 * is backed by `im-chats.json` (see {@link createWorkspaceImChatStore}); tests
 * inject an in-memory fake.
 */
export interface ImChatPersistence {
	load(): Promise<RuntimeImChatsData>;
	mutate(fn: (current: RuntimeImChatsData) => RuntimeImChatsData): Promise<RuntimeImChatsData>;
}

export interface ImChatStoreOptions {
	persistence: ImChatPersistence;
	now?: () => number;
}

export interface AddImChatRequest {
	platform: ImPlatform;
	chatId: string;
	/** Optional human-friendly label. Omit to keep an existing name (on re-add) or default to empty. */
	displayName?: string;
}

export interface RecordInboundImChatRequest {
	platform: ImPlatform;
	chatId: string;
	/** Optional label carried by the inbound event; usually absent (a raw chat id is all we know). */
	displayName?: string;
}

/**
 * Per-workspace orchestration over the IM chat list registry (`im-chat-registry.ts`):
 * composes the pure operations with persistence. Exposes async `list` / `add` (manual)
 * / `remove` plus `recordInbound` (the gateway auto-populate seam). No network surface —
 * the tRPC endpoints are a thin layer over this, and the inbound recorder calls
 * {@link recordInbound} directly.
 */
export class ImChatStore {
	private readonly persistence: ImChatPersistence;
	private readonly now: () => number;

	constructor(options: ImChatStoreOptions) {
		this.persistence = options.persistence;
		this.now = options.now ?? (() => Date.now());
	}

	async list(): Promise<RuntimeImChat[]> {
		return listImChats(await this.persistence.load());
	}

	/** Manually add (or update) a bindable chat. Returns the inserted-or-updated entry. */
	async add(request: AddImChatRequest): Promise<RuntimeImChat> {
		const now = this.now();
		let chat: RuntimeImChat | undefined;
		await this.persistence.mutate((current) => {
			const result = upsertManualImChat(current, { ...request, now });
			chat = result.chat;
			return result.next;
		});
		if (!chat) {
			// Unreachable: upsertManualImChat always returns a chat.
			throw new Error("Failed to add IM chat.");
		}
		return chat;
	}

	/** Remove a bindable chat by identity. Returns the removed entry. Throws if it is not present. */
	async remove(platform: ImPlatform, chatId: string): Promise<RuntimeImChat> {
		let removed: RuntimeImChat | undefined;
		await this.persistence.mutate((current) => {
			const result = removeImChat(current, platform, chatId);
			removed = result.removed;
			return result.next;
		});
		if (!removed) {
			// Unreachable: removeImChat throws when the entry is missing.
			throw new Error(`IM chat "${platform}:${chatId}" not found.`);
		}
		return removed;
	}

	/**
	 * Auto-record a chat discovered from a gateway inbound event. Returns the newly-created entry,
	 * or `null` when the chat was already in the list (a no-op that never rewrites persistence and
	 * never clobbers a user's manual entry). Callers treat a `null` return as "nothing to do".
	 */
	async recordInbound(request: RecordInboundImChatRequest): Promise<RuntimeImChat | null> {
		const now = this.now();
		let created: RuntimeImChat | null = null;
		await this.persistence.mutate((current) => {
			const result = recordInboundImChat(current, { ...request, now });
			if (!result) {
				// No change: return the same reference so the persistence layer skips the write.
				return current;
			}
			created = result.chat;
			return result.next;
		});
		return created;
	}
}

/** Build an `im-chats.json`-backed store for a workspace. */
export function createWorkspaceImChatStore(workspaceId: string): ImChatStore {
	return new ImChatStore({
		persistence: {
			load: () => loadWorkspaceImChats(workspaceId),
			mutate: (fn) => mutateWorkspaceImChats(workspaceId, fn),
		},
	});
}
