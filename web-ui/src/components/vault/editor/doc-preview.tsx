import type React from "react";

import { KanbanMarkdownContent } from "@/components/detail-panels/kanban-markdown-content";

/**
 * Markdown preview for a vault document body. Delegates to the existing
 * `KanbanMarkdownContent` renderer (GFM + Prism, token-styled) so the editor and
 * the rest of the app render markdown identically.
 */
export function DocPreview({ body }: { body: string }): React.ReactElement {
	if (!body.trim()) {
		return <p className="px-1 py-2 text-[13px] text-text-tertiary">Nothing to preview yet.</p>;
	}
	return <KanbanMarkdownContent content={body} />;
}
