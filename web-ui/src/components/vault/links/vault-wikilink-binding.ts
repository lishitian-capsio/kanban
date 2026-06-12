import type { KanbanMarkdownWikilinks } from "@/components/detail-panels/kanban-markdown-content";

import type { VaultDoc } from "../data/vault-doc-model";

/**
 * Everything the document editor needs to make body `[[wikilinks]]` interactive:
 * the candidate pool for autocomplete and the render-time resolution/handlers.
 * Threaded from `VaultView` (which owns the data + navigation) down to the editor.
 */
export interface VaultWikilinkBinding {
	/** Every vault doc across types — the `[[` autocomplete candidate pool. */
	candidates: VaultDoc[];
	/** The doc currently open; excluded from its own candidate list. */
	currentDocId: string;
	/** Resolution + open/create handlers used when rendering the preview. */
	rendering: KanbanMarkdownWikilinks;
}
