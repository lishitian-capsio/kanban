// Owns the per-workspace bindable "IM 会话 id 列表" (the palette a home thread's
// `imChannel` points at — requirement ac99c, task 159ab).
//
// The list is the source of truth for binding: the picker selects one of these
// entries to bind onto a thread. Entries arrive two ways (task 0a675): manually
// added here (`addChat`, an upsert) and auto-recorded when a chat @'s the bot
// inbound. This hook is a thin list query plus the manual upsert — removal from
// the palette is a management concern, out of the binding surface's scope.
//
// Reached through the per-workspace `runtime.*ImChat` tRPC endpoints, mirroring
// the direct-client pattern in `use-home-threads`.

import { useCallback, useEffect, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeImChat, RuntimeImChatAddRequest } from "@/runtime/types";

export interface UseImChatsResult {
	/** The bindable palette for the workspace (sorted server-side, most-recent first). */
	chats: RuntimeImChat[];
	isLoading: boolean;
	/** Set when the list query cannot reach the runtime. The last good list stays visible. */
	error: string | null;
	/** Re-fetch the palette. */
	refresh: () => Promise<void>;
	/**
	 * Upsert a chat into the palette (manual add). Returns the stored entry, or null on
	 * failure (a toast is surfaced). Used by the picker's "add a new id and select it" flow
	 * so a manually-bound chat becomes a reusable list entry.
	 */
	addChat: (request: RuntimeImChatAddRequest) => Promise<RuntimeImChat | null>;
}

function sameChat(a: RuntimeImChat, b: RuntimeImChat): boolean {
	return a.platform === b.platform && a.chatId === b.chatId;
}

export function useImChats(workspaceId: string | null): UseImChatsResult {
	const [chats, setChats] = useState<RuntimeImChat[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Track the workspace the current `chats` belong to so a workspace switch clears
	// the stale palette immediately (rather than flashing the previous workspace's list).
	const loadedWorkspaceRef = useRef<string | null>(null);

	const load = useCallback(async (targetWorkspaceId: string) => {
		setIsLoading(true);
		try {
			const response = await getRuntimeTrpcClient(targetWorkspaceId).runtime.listImChats.query();
			if (!response.ok) {
				throw new Error(response.error ?? "Could not load the IM chat list.");
			}
			loadedWorkspaceRef.current = targetWorkspaceId;
			setChats(response.chats);
			setError(null);
		} catch (caught) {
			// Keep the last good list visible; surface the failure without poisoning the cache.
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!workspaceId) {
			setChats([]);
			loadedWorkspaceRef.current = null;
			return;
		}
		if (loadedWorkspaceRef.current !== workspaceId) {
			setChats([]);
		}
		void load(workspaceId);
	}, [workspaceId, load]);

	const refresh = useCallback(async () => {
		if (workspaceId) {
			await load(workspaceId);
		}
	}, [workspaceId, load]);

	const addChat = useCallback(
		async (request: RuntimeImChatAddRequest): Promise<RuntimeImChat | null> => {
			if (!workspaceId) {
				return null;
			}
			try {
				const response = await getRuntimeTrpcClient(workspaceId).runtime.addImChat.mutate(request);
				if (!response.ok || !response.chat) {
					throw new Error(response.error ?? "Could not add the IM chat.");
				}
				const added = response.chat;
				setChats((current) => {
					const withoutDupe = current.filter((chat) => !sameChat(chat, added));
					return [added, ...withoutDupe];
				});
				return added;
			} catch (caught) {
				notifyError(caught instanceof Error ? caught.message : String(caught));
				return null;
			}
		},
		[workspaceId],
	);

	return { chats, isLoading, error, refresh, addChat };
}
