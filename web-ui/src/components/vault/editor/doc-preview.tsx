import type React from "react";

import { KanbanMarkdownContent, type KanbanMarkdownWikilinks } from "@/components/detail-panels/kanban-markdown-content";

/**
 * Markdown preview for a vault document body. Delegates to the existing
 * `KanbanMarkdownContent` renderer (GFM + Prism, token-styled) so the editor and
 * the rest of the app render markdown identically. When a `wikilinks` binding is
 * supplied, body `[[links]]` render as interactive chips.
 */
export function DocPreview({
	body,
	wikilinks,
}: {
	body: string;
	wikilinks?: KanbanMarkdownWikilinks;
}): React.ReactElement {
	if (!body.trim()) {
		return <p className="px-1 py-2 text-[13px] text-text-tertiary">Nothing to preview yet.</p>;
	}
	return <KanbanMarkdownContent content={body} wikilinks={wikilinks} />;
}
