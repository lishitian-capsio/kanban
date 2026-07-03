import type { KeyboardEvent, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	type ActiveKanbanComposerToken,
	applyKanbanComposerCompletion,
	buildMentionInsertText,
	buildSlashCommandInsertText,
	detectActiveKanbanComposerToken,
	type KanbanComposerCompletionSuggestion,
} from "@/components/detail-panels/kanban-chat-composer-completion";
import type { InlineCompletionItem } from "@/components/inline-completion-picker";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeSlashCommand } from "@/runtime/types";
import { useDebouncedEffect } from "@/utils/react-use";

const COMPLETION_DEBOUNCE_MS = 120;
const FILE_MENTION_LIMIT = 8;
const SLASH_COMMAND_LIMIT = 8;

export interface UseKanbanComposerCompletionParams {
	/** Current textarea value. */
	value: string;
	/** Called to replace the value when a suggestion is applied. */
	onValueChange: (value: string) => void;
	/** The textarea the completion picker anchors to (for focus/caret after apply). */
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	/** Workspace scope for `@` file mentions. Mentions are inert without it. */
	workspaceId?: string | null;
	/** When false, completion is fully disabled (e.g. the composer is read-only). */
	enabled?: boolean;
	/** Opt-in `/` slash-command completion. Off by default so task forms stay mention-only. */
	enableSlashCommands?: boolean;
}

export interface KanbanComposerCompletion {
	cursorIndex: number;
	setCursorIndex: (index: number) => void;
	activeToken: ActiveKanbanComposerToken | null;
	showCompletionPicker: boolean;
	completionItems: InlineCompletionItem[];
	selectedCompletionIndex: number;
	setSelectedCompletionIndex: (index: number) => void;
	isCompletionLoading: boolean;
	completionLoadingMessage: string;
	completionEmptyMessage: string | null;
	onSelectCompletionItem: (item: InlineCompletionItem) => void;
	/**
	 * Handles the picker's navigation/accept/dismiss keys (↑ ↓ Tab Enter Esc).
	 * Returns true when it consumed the event, so callers can early-return and keep
	 * their own key bindings (submit, mode toggle, cancel) untouched.
	 */
	handleCompletionKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * Shared `@`-mention + `/`-slash-command completion engine for the Kanban chat
 * composer and the task/thread prompt composer. Owns caret tracking, the two
 * async data sources, picker open/selection state, and the keyboard navigation
 * used to drive {@link InlineCompletionPicker}. The pure token/insert helpers
 * live in `kanban-chat-composer-completion.ts`.
 */
export function useKanbanComposerCompletion({
	value,
	onValueChange,
	textareaRef,
	workspaceId = null,
	enabled = true,
	enableSlashCommands = false,
}: UseKanbanComposerCompletionParams): KanbanComposerCompletion {
	const mentionSearchRequestIdRef = useRef(0);
	const slashCommandsRequestIdRef = useRef(0);
	const slashCommandsCacheRef = useRef(new Map<string, RuntimeSlashCommand[]>());

	const [cursorIndex, setCursorIndex] = useState(() => value.length);
	const [isCompletionPickerOpen, setIsCompletionPickerOpen] = useState(true);
	const [selectedCompletionIndex, setSelectedCompletionIndex] = useState(0);
	const [mentionSuggestions, setMentionSuggestions] = useState<KanbanComposerCompletionSuggestion[]>([]);
	const [slashSuggestions, setSlashSuggestions] = useState<KanbanComposerCompletionSuggestion[]>([]);
	const [isMentionSearchLoading, setIsMentionSearchLoading] = useState(false);
	const [isSlashSearchLoading, setIsSlashSearchLoading] = useState(false);

	const activeToken = useMemo(() => {
		if (!enabled) {
			return null;
		}
		const token = detectActiveKanbanComposerToken(value, cursorIndex);
		if (!token) {
			return null;
		}
		if (token.kind === "slash" && !enableSlashCommands) {
			return null;
		}
		return token;
	}, [cursorIndex, enableSlashCommands, enabled, value]);

	const completionSuggestions = useMemo(() => {
		if (!activeToken) {
			return [] as KanbanComposerCompletionSuggestion[];
		}
		return activeToken.kind === "mention" ? mentionSuggestions : slashSuggestions;
	}, [activeToken, mentionSuggestions, slashSuggestions]);

	const completionItems = useMemo<InlineCompletionItem[]>(
		() => completionSuggestions.map((suggestion) => ({ id: suggestion.id, label: suggestion.label, detail: suggestion.detail })),
		[completionSuggestions],
	);

	const isCompletionLoading = activeToken?.kind === "mention" ? isMentionSearchLoading : isSlashSearchLoading;
	const showCompletionPicker = Boolean(activeToken && isCompletionPickerOpen);
	const completionLoadingMessage = activeToken?.kind === "mention" ? "Loading files..." : "Loading commands...";
	const completionEmptyMessage = useMemo(() => {
		if (!activeToken) {
			return null;
		}
		if (activeToken.kind === "mention" && !workspaceId) {
			return "Select a workspace to mention files.";
		}
		if (activeToken.kind === "mention") {
			return "No matching files.";
		}
		return "No matching commands.";
	}, [activeToken, workspaceId]);

	// Keep the tracked caret within bounds when the value shrinks externally.
	useEffect(() => {
		setCursorIndex((currentValue) => Math.min(currentValue, value.length));
	}, [value.length]);

	// Re-open the picker and reset the highlight whenever the active token changes.
	useEffect(() => {
		setSelectedCompletionIndex(0);
		setIsCompletionPickerOpen(true);
	}, [activeToken?.kind, activeToken?.query, activeToken?.start]);

	// Drop stale suggestions when the token no longer targets that data source.
	useEffect(() => {
		if (!activeToken || activeToken.kind !== "mention") {
			mentionSearchRequestIdRef.current += 1;
			setMentionSuggestions([]);
			setIsMentionSearchLoading(false);
		}
		if (!activeToken || activeToken.kind !== "slash") {
			slashCommandsRequestIdRef.current += 1;
			setSlashSuggestions([]);
			setIsSlashSearchLoading(false);
		}
	}, [activeToken]);

	useDebouncedEffect(
		() => {
			if (!activeToken || activeToken.kind !== "mention" || !workspaceId) {
				return;
			}
			const requestId = ++mentionSearchRequestIdRef.current;
			setIsMentionSearchLoading(true);
			void (async () => {
				try {
					const payload = await getRuntimeTrpcClient(workspaceId).workspace.searchFiles.query({
						query: activeToken.query,
						limit: FILE_MENTION_LIMIT,
					});
					if (requestId !== mentionSearchRequestIdRef.current) {
						return;
					}
					const files = Array.isArray(payload.files) ? payload.files : [];
					setMentionSuggestions(
						files.map((file) => ({
							id: file.path,
							kind: "mention",
							label: file.name,
							detail: file.path,
							insertText: buildMentionInsertText(file.path),
						})),
					);
				} catch {
					if (requestId === mentionSearchRequestIdRef.current) {
						setMentionSuggestions([]);
					}
				} finally {
					if (requestId === mentionSearchRequestIdRef.current) {
						setIsMentionSearchLoading(false);
					}
				}
			})();
		},
		COMPLETION_DEBOUNCE_MS,
		[activeToken, workspaceId],
	);

	useDebouncedEffect(
		() => {
			if (!activeToken || activeToken.kind !== "slash") {
				return;
			}
			const requestKey = workspaceId ?? "__global__";
			const requestId = ++slashCommandsRequestIdRef.current;
			const applyCommands = (commands: RuntimeSlashCommand[]) => {
				const query = activeToken.query.trim().toLowerCase();
				setSlashSuggestions(
					commands
						.filter((command) => {
							if (query.length === 0) {
								return true;
							}
							const description = command.description?.toLowerCase() ?? "";
							return command.name.toLowerCase().includes(query) || description.includes(query);
						})
						.slice(0, SLASH_COMMAND_LIMIT)
						.map((command) => ({
							id: command.name,
							kind: "slash" as const,
							label: `/${command.name}`,
							detail: command.description,
							insertText: buildSlashCommandInsertText(command.name),
						})),
				);
			};

			const cachedCommands = slashCommandsCacheRef.current.get(requestKey);
			if (cachedCommands) {
				applyCommands(cachedCommands);
				return;
			}

			setIsSlashSearchLoading(true);
			void (async () => {
				try {
					const payload = await getRuntimeTrpcClient(workspaceId).runtime.getKanbanSlashCommands.query();
					if (requestId !== slashCommandsRequestIdRef.current) {
						return;
					}
					slashCommandsCacheRef.current.set(requestKey, payload.commands);
					applyCommands(payload.commands);
				} catch {
					if (requestId === slashCommandsRequestIdRef.current) {
						setSlashSuggestions([]);
					}
				} finally {
					if (requestId === slashCommandsRequestIdRef.current) {
						setIsSlashSearchLoading(false);
					}
				}
			})();
		},
		COMPLETION_DEBOUNCE_MS,
		[activeToken, workspaceId],
	);

	const applySuggestion = useCallback(
		(suggestion: KanbanComposerCompletionSuggestion, token: ActiveKanbanComposerToken) => {
			const next = applyKanbanComposerCompletion(value, token, suggestion.insertText);
			onValueChange(next.value);
			window.requestAnimationFrame(() => {
				const textarea = textareaRef.current;
				if (!textarea) {
					return;
				}
				textarea.focus();
				textarea.setSelectionRange(next.cursor, next.cursor);
				setCursorIndex(next.cursor);
			});
		},
		[onValueChange, textareaRef, value],
	);

	const onSelectCompletionItem = useCallback(
		(item: InlineCompletionItem) => {
			const suggestion = completionSuggestions.find((candidate) => candidate.id === item.id);
			if (suggestion && activeToken) {
				applySuggestion(suggestion, activeToken);
			}
		},
		[activeToken, applySuggestion, completionSuggestions],
	);

	const handleCompletionKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
			const canNavigate = showCompletionPicker && completionSuggestions.length > 0;
			if (canNavigate && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
				event.preventDefault();
				const direction = event.key === "ArrowDown" ? 1 : -1;
				setSelectedCompletionIndex((currentValue) => {
					const nextIndex = currentValue + direction;
					if (nextIndex < 0) {
						return completionSuggestions.length - 1;
					}
					if (nextIndex >= completionSuggestions.length) {
						return 0;
					}
					return nextIndex;
				});
				return true;
			}
			if (canNavigate && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
				event.preventDefault();
				const selectedSuggestion = completionSuggestions[selectedCompletionIndex] ?? completionSuggestions[0];
				if (selectedSuggestion && activeToken) {
					applySuggestion(selectedSuggestion, activeToken);
				}
				return true;
			}
			if (event.key === "Escape" && showCompletionPicker) {
				event.preventDefault();
				setIsCompletionPickerOpen(false);
				return true;
			}
			return false;
		},
		[activeToken, applySuggestion, completionSuggestions, selectedCompletionIndex, showCompletionPicker],
	);

	return {
		cursorIndex,
		setCursorIndex,
		activeToken,
		showCompletionPicker,
		completionItems,
		selectedCompletionIndex,
		setSelectedCompletionIndex,
		isCompletionLoading,
		completionLoadingMessage,
		completionEmptyMessage,
		onSelectCompletionItem,
		handleCompletionKeyDown,
	};
}
