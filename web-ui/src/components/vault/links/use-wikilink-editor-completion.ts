import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { InlineCompletionItem } from "@/components/inline-completion-picker";

import type { VaultDoc } from "../data/vault-doc-model";
import { searchWikilinkCandidates } from "./wikilink-candidates";
import {
	applyWikilinkCompletion,
	detectActiveWikilinkToken,
	wikilinkLabelPart,
	wikilinkSearchTerm,
} from "./wikilink-completion";

const CANDIDATE_LIMIT = 8;

export interface UseWikilinkEditorCompletionParams {
	/** Current editor body (parent-owned). */
	value: string;
	onChange: (next: string) => void;
	/** Candidate pool: every vault doc across types. */
	candidates: VaultDoc[];
	/** The doc being edited; excluded from its own candidate list. */
	currentDocId: string;
	/** Resolves the live textarea element (e.g. the MDEditor inner textarea). */
	getTextarea: () => HTMLTextAreaElement | null;
}

export interface WikilinkEditorCompletion {
	open: boolean;
	items: InlineCompletionItem[];
	selectedIndex: number;
	emptyMessage: string | null;
	setSelectedIndex: (index: number) => void;
	/** Insert the chosen candidate, closing the brackets and moving the cursor. */
	selectItem: (item: InlineCompletionItem) => void;
	/** Keydown handler for the textarea (arrow/enter/tab/escape navigation). */
	handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
	/** Re-read the caret position after a value/selection change. */
	syncCaret: () => void;
}

/**
 * Drives the `[[` autocomplete menu over a textarea. Mirrors the chat composer's
 * approach (`kanban-chat-composer.tsx`): track the caret, derive the active token
 * with the pure `detectActiveWikilinkToken`, and rewrite the text with
 * `applyWikilinkCompletion`. Candidate ranking is local (fzf); link *resolution*
 * stays on the B1 backend. Decoupled from the editor widget via `getTextarea` so
 * it can be unit-tested against a plain textarea.
 */
export function useWikilinkEditorCompletion({
	value,
	onChange,
	candidates,
	currentDocId,
	getTextarea,
}: UseWikilinkEditorCompletionParams): WikilinkEditorCompletion {
	const [caret, setCaret] = useState(() => value.length);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [dismissed, setDismissed] = useState(false);

	const activeToken = useMemo(() => detectActiveWikilinkToken(value, caret), [value, caret]);

	const matches = useMemo(() => {
		if (!activeToken) {
			return [];
		}
		return searchWikilinkCandidates(candidates, wikilinkSearchTerm(activeToken.query), {
			limit: CANDIDATE_LIMIT,
			excludeId: currentDocId,
		});
	}, [activeToken, candidates, currentDocId]);

	const items = useMemo<InlineCompletionItem[]>(
		() => matches.map((match) => ({ id: match.id, label: match.title, detail: match.type })),
		[matches],
	);

	// Reset selection + un-dismiss whenever the active token changes.
	useEffect(() => {
		setSelectedIndex(0);
		setDismissed(false);
	}, [activeToken?.start, activeToken?.query]);

	// Keep the caret in range if the value shrinks out from under us.
	useEffect(() => {
		setCaret((current) => Math.min(current, value.length));
	}, [value.length]);

	const syncCaret = useCallback(() => {
		const textarea = getTextarea();
		if (textarea) {
			setCaret(textarea.selectionStart ?? textarea.value.length);
		}
	}, [getTextarea]);

	const apply = useCallback(
		(match: { title: string }) => {
			if (!activeToken) {
				return;
			}
			const label = wikilinkLabelPart(activeToken.query);
			const next = applyWikilinkCompletion(value, activeToken, match.title, label);
			onChange(next.value);
			setCaret(next.cursor);
			window.requestAnimationFrame(() => {
				const textarea = getTextarea();
				if (textarea) {
					textarea.focus();
					textarea.setSelectionRange(next.cursor, next.cursor);
				}
			});
		},
		[activeToken, getTextarea, onChange, value],
	);

	const selectItem = useCallback(
		(item: InlineCompletionItem) => {
			const match = matches.find((candidate) => candidate.id === item.id);
			if (match) {
				apply(match);
			}
		},
		[apply, matches],
	);

	const open = Boolean(activeToken) && !dismissed;

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.nativeEvent.isComposing || !open) {
				return;
			}
			const canNavigate = items.length > 0;
			if (canNavigate && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
				event.preventDefault();
				const direction = event.key === "ArrowDown" ? 1 : -1;
				setSelectedIndex((current) => {
					const next = current + direction;
					if (next < 0) {
						return items.length - 1;
					}
					if (next >= items.length) {
						return 0;
					}
					return next;
				});
				return;
			}
			if (canNavigate && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
				event.preventDefault();
				const item = items[selectedIndex] ?? items[0];
				if (item) {
					selectItem(item);
				}
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissed(true);
			}
		},
		[items, open, selectItem, selectedIndex],
	);

	const emptyMessage = activeToken
		? candidates.length === 0
			? "No documents to link yet."
			: "No matching documents."
		: null;

	return {
		open,
		items,
		selectedIndex,
		emptyMessage,
		setSelectedIndex,
		selectItem,
		handleKeyDown,
		syncCaret,
	};
}
