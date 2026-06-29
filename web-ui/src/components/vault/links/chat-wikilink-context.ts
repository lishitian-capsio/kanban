import { createContext, useContext } from "react";

import type { KanbanMarkdownWikilinks } from "@/components/detail-panels/kanban-markdown-content";

/**
 * Optional `[[wikilink]]` binding for chat/markdown surfaces OUTSIDE the vault
 * (home chat, task chat). `undefined` ⇒ render plain markdown (no chips). The
 * binding reference is stable (see `ChatWikilinkProvider`) so reading it never
 * defeats `KanbanMarkdownContent`'s per-message memoization during streaming.
 */
export const ChatWikilinkContext = createContext<KanbanMarkdownWikilinks | undefined>(undefined);

export function useChatWikilinks(): KanbanMarkdownWikilinks | undefined {
	return useContext(ChatWikilinkContext);
}
