/**
 * Pure cursor logic for `[[wikilink]]` autocomplete inside the body editor.
 * Mirrors the chat composer's `detect…Token` / `apply…Completion` split
 * (`kanban-chat-composer-completion.ts`) so the editor wiring stays declarative
 * and every branch is unit-testable without a DOM.
 *
 * Resolution of a target to a document is NOT done here — it is delegated to the
 * B1 backend link engine (`workspace.getDocumentLinks`). This module only finds
 * the token under the cursor and rewrites the raw text.
 */

export interface ActiveWikilinkToken {
	/** Index of the first `[` of the opening `[[`. */
	start: number;
	/** Cursor index (exclusive end of the typed query). */
	end: number;
	/** Raw text between `[[` and the cursor, e.g. `Acme` or `Acme|the cli`. */
	query: string;
}

const OPEN = "[[";

/**
 * Find the open (unclosed) wikilink the cursor sits inside, or null. A token is
 * active when the nearest `[[` before the cursor is not yet closed by `]]` and
 * does not span a newline (wikilinks are single-line).
 */
export function detectActiveWikilinkToken(value: string, cursorIndex: number): ActiveWikilinkToken | null {
	if (cursorIndex < 0 || cursorIndex > value.length) {
		return null;
	}
	const head = value.slice(0, cursorIndex);
	const start = head.lastIndexOf(OPEN);
	if (start === -1) {
		return null;
	}
	const inner = head.slice(start + OPEN.length);
	if (inner.includes("]]") || inner.includes("\n")) {
		return null;
	}
	return { start, end: cursorIndex, query: inner };
}

/** The target portion of a query (text before the first `|`), trimmed. */
export function wikilinkSearchTerm(query: string): string {
	const pipe = query.indexOf("|");
	return (pipe === -1 ? query : query.slice(0, pipe)).trim();
}

/** The label portion of a query (text after the first `|`), or undefined when blank. */
export function wikilinkLabelPart(query: string): string | undefined {
	const pipe = query.indexOf("|");
	if (pipe === -1) {
		return undefined;
	}
	const label = query.slice(pipe + 1).trim();
	return label.length > 0 ? label : undefined;
}

/**
 * Replace the active token with a complete `[[target]]` (or `[[target|label]]`)
 * and return the new value plus the cursor position just after the closing `]]`.
 * Any closing brackets already present right after the cursor are consumed so we
 * never produce `[[target]]]]`.
 */
export function applyWikilinkCompletion(
	value: string,
	token: ActiveWikilinkToken,
	target: string,
	label?: string,
): { value: string; cursor: number } {
	const before = value.slice(0, token.start);
	const trailing = value.slice(token.end);
	const after = trailing.startsWith("]]") ? trailing.slice(2) : trailing;
	const useLabel = label && label !== target ? label : undefined;
	const replacement = useLabel ? `[[${target}|${useLabel}]]` : `[[${target}]]`;
	return {
		value: `${before}${replacement}${after}`,
		cursor: before.length + replacement.length,
	};
}
