import type { RuntimeImChat, RuntimeImChatsData } from "../core/api-contract";
import type { ImPlatform } from "../im/types";

/**
 * Pure, I/O-free operations over the persisted per-workspace IM chat list
 * (requirement ac99c) — the palette of bindable 飞书/钉钉 conversations a home
 * chat thread's `imChannel` can point at.
 *
 * Each function takes the current {@link RuntimeImChatsData} plus parameters and
 * returns a new value without mutating the input. Persistence, locking, and the
 * gateway inbound seam live in the surrounding store (`im-chat-store.ts`).
 *
 * An entry's identity is the (platform, chatId) pair. Two sources populate the
 * list: a user `manual` add, and an `inbound` auto-record of a chat that @'d the
 * bot. The two never fight — an inbound auto-record never overwrites a manual
 * entry (see {@link recordInboundImChat}).
 */

/** True when two entries denote the same chat (identity = platform + chatId). */
function sameChat(a: { platform: ImPlatform; chatId: string }, b: { platform: ImPlatform; chatId: string }): boolean {
	return a.platform === b.platform && a.chatId === b.chatId;
}

/**
 * Return the chats ordered most-recently-touched first (a re-add / inbound hit bumps `updatedAt`),
 * so the freshest bindable conversations sit at the top of the palette. Stable tiebreak on chatId.
 */
export function listImChats(data: RuntimeImChatsData): RuntimeImChat[] {
	return [...data.chats].sort((a, b) => b.updatedAt - a.updatedAt || a.chatId.localeCompare(b.chatId));
}

export interface UpsertImChatInput {
	platform: ImPlatform;
	chatId: string;
	/** New display name. Omit to keep the existing name on update, or default to empty on insert. */
	displayName?: string;
	now: number;
}

export interface UpsertImChatResult {
	next: RuntimeImChatsData;
	/** The inserted-or-updated entry. */
	chat: RuntimeImChat;
}

/**
 * Manually add a chat, or update the one already stored under the same (platform, chatId).
 * A re-add marks the entry `manual` (a user has confirmed it) and, when a new `displayName` is
 * supplied, replaces the label; a re-add always bumps `updatedAt` so it floats to the top.
 */
export function upsertManualImChat(data: RuntimeImChatsData, input: UpsertImChatInput): UpsertImChatResult {
	const existing = data.chats.find((chat) => sameChat(chat, input));
	if (existing) {
		const updated: RuntimeImChat = {
			...existing,
			displayName: input.displayName ?? existing.displayName,
			source: "manual",
			updatedAt: input.now,
		};
		return {
			next: { ...data, chats: data.chats.map((chat) => (sameChat(chat, input) ? updated : chat)) },
			chat: updated,
		};
	}
	const created: RuntimeImChat = {
		platform: input.platform,
		chatId: input.chatId,
		displayName: input.displayName ?? "",
		source: "manual",
		createdAt: input.now,
		updatedAt: input.now,
	};
	return { next: { ...data, chats: [...data.chats, created] }, chat: created };
}

/**
 * Auto-record a chat discovered from a gateway inbound event (a chat that @'d the bot). Inserts a
 * new `inbound` entry when the (platform, chatId) is not yet in the list; when it already exists —
 * whether `manual` or `inbound` — this is a no-op that returns the SAME data reference (so a chat
 * chatting repeatedly never rewrites the list, and a user's manual label/source is never clobbered).
 */
export function recordInboundImChat(data: RuntimeImChatsData, input: UpsertImChatInput): UpsertImChatResult | null {
	if (data.chats.some((chat) => sameChat(chat, input))) {
		return null;
	}
	const created: RuntimeImChat = {
		platform: input.platform,
		chatId: input.chatId,
		displayName: input.displayName ?? "",
		source: "inbound",
		createdAt: input.now,
		updatedAt: input.now,
	};
	return { next: { ...data, chats: [...data.chats, created] }, chat: created };
}

/**
 * Backfill a display name onto an already-recorded chat, WITHOUT changing its `source` or bumping
 * `updatedAt` — used to lazily label an `inbound`-discovered chat once the platform resolves its
 * name (see the inbound recorder). Returns the SAME data reference (so persistence skips the write)
 * unless the chat exists AND currently has an empty name; a chat that already has a name — a user's
 * manual label or a prior successful resolution — is never clobbered.
 */
export function setImChatDisplayName(
	data: RuntimeImChatsData,
	platform: ImPlatform,
	chatId: string,
	displayName: string,
): RuntimeImChatsData {
	const name = displayName.trim();
	if (!name) {
		return data;
	}
	const existing = data.chats.find((chat) => sameChat(chat, { platform, chatId }));
	if (!existing || (existing.displayName && existing.displayName.length > 0)) {
		return data;
	}
	const updated: RuntimeImChat = { ...existing, displayName: name };
	return { ...data, chats: data.chats.map((chat) => (sameChat(chat, { platform, chatId }) ? updated : chat)) };
}

export interface RemoveImChatResult {
	next: RuntimeImChatsData;
	removed: RuntimeImChat;
}

/** Remove the chat with the given (platform, chatId). Throws if no such entry exists. */
export function removeImChat(data: RuntimeImChatsData, platform: ImPlatform, chatId: string): RemoveImChatResult {
	const removed = data.chats.find((chat) => sameChat(chat, { platform, chatId }));
	if (!removed) {
		throw new Error(`IM chat "${platform}:${chatId}" not found.`);
	}
	return {
		next: { ...data, chats: data.chats.filter((chat) => !sameChat(chat, { platform, chatId })) },
		removed,
	};
}
