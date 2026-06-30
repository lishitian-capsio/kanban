/**
 * Insert a snippet into a composer draft. Empty drafts are replaced outright;
 * non-empty drafts get the snippet on a fresh blank line; an empty snippet leaves
 * the draft untouched. Used by the chat panel's `appendToDraft` imperative handle
 * (e.g. inserting a code reference from the card detail view).
 */
export function appendTextToDraft(draft: string, text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return draft;
	}
	if (draft.trim().length === 0) {
		return trimmed;
	}
	return `${draft.trimEnd()}\n\n${trimmed}`;
}
