import { lazy, Suspense, type ReactElement } from "react";

import type { KanbanMarkdownWikilinks } from "@/components/detail-panels/kanban-markdown-content";

// `kanban-markdown-content` statically pulls react-markdown, remark-gfm and 23
// prismjs grammar modules — the single heaviest dependency on the first-paint
// path (the home sidebar chat is open by default). Loading it lazily keeps that
// chunk off the entry bundle: the chat shell paints immediately and the raw
// text is shown until the markdown renderer chunk resolves (a one-time fetch
// per session). The eager importers of `KanbanMarkdownContent` (card detail /
// vault) already live in their own lazy view chunks, so the shared markdown
// chunk never leaks back into the entry.
const KanbanMarkdownContentInner = lazy(() =>
	import("@/components/detail-panels/kanban-markdown-content").then((module) => ({
		default: module.KanbanMarkdownContent,
	})),
);

export function LazyKanbanMarkdownContent(props: {
	content: string;
	wikilinks?: KanbanMarkdownWikilinks;
}): ReactElement {
	return (
		<Suspense fallback={<div className="kb-markdown min-w-0 whitespace-pre-wrap break-words">{props.content}</div>}>
			<KanbanMarkdownContentInner {...props} />
		</Suspense>
	);
}
