// Manages the message list and send or cancel lifecycle for one native Kanban session.
// It merges loaded history with streamed updates and guards against stale task
// switches so chat surfaces can stay reactive without duplicating logic.
import { useCallback, useEffect, useState } from "react";
import type { KanbanChatActionResult } from "@/hooks/use-kanban-chat-runtime-actions";
import type { RuntimeTaskChatMessage, RuntimeTaskImage, RuntimeTaskSessionMode } from "@/runtime/types";

export type KanbanChatMessage = RuntimeTaskChatMessage;

interface UseKanbanChatSessionInput {
	taskId: string;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
	) => Promise<KanbanChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<KanbanChatMessage[] | null>;
	incomingMessages?: KanbanChatMessage[] | null;
	incomingMessage?: KanbanChatMessage | null;
}

interface UseKanbanChatSessionResult {
	messages: KanbanChatMessage[];
	isSending: boolean;
	// True only while the initial `onLoadMessages` history fetch is in flight.
	// Exposed distinctly from `isSending` (which still folds it in for the
	// composer's busy state) so surfaces can show a history-loading skeleton
	// without confusing it with an in-progress send/stream.
	isLoadingHistory: boolean;
	isCanceling: boolean;
	error: string | null;
	sendMessage: (
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
	) => Promise<boolean>;
	cancelTurn: () => Promise<boolean>;
}

function areMessagesEqual(left: KanbanChatMessage, right: KanbanChatMessage): boolean {
	return (
		left.content === right.content &&
		left.role === right.role &&
		left.createdAt === right.createdAt &&
		JSON.stringify(left.meta ?? null) === JSON.stringify(right.meta ?? null)
	);
}

function upsertMessage(currentMessages: KanbanChatMessage[], nextMessage: KanbanChatMessage): KanbanChatMessage[] {
	const existingIndex = currentMessages.findIndex((message) => message.id === nextMessage.id);
	if (existingIndex < 0) {
		return [...currentMessages, nextMessage];
	}
	const existingMessage = currentMessages[existingIndex];
	if (!existingMessage || areMessagesEqual(existingMessage, nextMessage)) {
		return currentMessages;
	}
	const nextMessages = [...currentMessages];
	nextMessages[existingIndex] = nextMessage;
	return nextMessages;
}

// Merges `additionalMessages` into `baseMessages` by id in O(N + M) using a
// single id→index map, instead of an O(N·M) findIndex-per-message scan. This
// matters because streaming feeds the whole task array in every token, so a
// naive merge degrades to O(N²) per token on long conversations. Returns the
// same array reference when nothing changed so React can bail out of renders.
function mergeMessages(baseMessages: KanbanChatMessage[], additionalMessages: KanbanChatMessage[]): KanbanChatMessage[] {
	if (additionalMessages.length === 0) {
		return baseMessages;
	}
	const indexById = new Map<string, number>();
	for (let index = 0; index < baseMessages.length; index += 1) {
		const message = baseMessages[index];
		if (message) {
			indexById.set(message.id, index);
		}
	}
	let nextMessages = baseMessages;
	const ensureMutable = (): void => {
		if (nextMessages === baseMessages) {
			nextMessages = [...baseMessages];
		}
	};
	for (const message of additionalMessages) {
		const existingIndex = indexById.get(message.id);
		if (existingIndex === undefined) {
			ensureMutable();
			indexById.set(message.id, nextMessages.length);
			nextMessages.push(message);
			continue;
		}
		const existingMessage = nextMessages[existingIndex];
		if (existingMessage && !areMessagesEqual(existingMessage, message)) {
			ensureMutable();
			nextMessages[existingIndex] = message;
		}
	}
	return nextMessages;
}

export function useKanbanChatSession({
	taskId,
	onSendMessage,
	onCancelTurn,
	onLoadMessages,
	incomingMessages = null,
	incomingMessage = null,
}: UseKanbanChatSessionInput): UseKanbanChatSessionResult {
	const [messages, setMessages] = useState<KanbanChatMessage[]>([]);
	const [isSending, setIsSending] = useState(false);
	const [isCanceling, setIsCanceling] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setMessages([]);
		setError(null);
	}, [taskId]);

	useEffect(() => {
		if (!onLoadMessages) {
			setMessages([]);
			return;
		}
		setError(null);
		let cancelled = false;
		setIsLoading(true);
		void onLoadMessages(taskId)
			.then((loadedMessages) => {
				if (cancelled) {
					return;
				}
				setMessages((currentMessages) => mergeMessages(loadedMessages ?? [], currentMessages));
			})
			.catch((loadError) => {
				if (cancelled) {
					return;
				}
				const message = loadError instanceof Error ? loadError.message : String(loadError);
				setError(message);
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [onLoadMessages, taskId]);

	useEffect(() => {
		if (incomingMessages === null) {
			return;
		}
		if (incomingMessages.length === 0) {
			setMessages([]);
			return;
		}
		setMessages((currentMessages) => mergeMessages(currentMessages, incomingMessages));
	}, [incomingMessages]);

	useEffect(() => {
		if (!incomingMessage) {
			return;
		}
		setMessages((currentMessages) => upsertMessage(currentMessages, incomingMessage));
	}, [incomingMessage]);

	const cancelTurn = useCallback(async (): Promise<boolean> => {
		if (!onCancelTurn || isCanceling) {
			return false;
		}
		setError(null);
		setIsCanceling(true);
		try {
			const result = await onCancelTurn(taskId);
			if (!result.ok) {
				setError(result.message ?? "Could not cancel turn.");
				return false;
			}
			return true;
		} catch (cancelError) {
			const message = cancelError instanceof Error ? cancelError.message : String(cancelError);
			setError(message);
			return false;
		} finally {
			setIsCanceling(false);
		}
	}, [isCanceling, onCancelTurn, taskId]);

	const sendMessage = useCallback(
		async (
			text: string,
			options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
		): Promise<boolean> => {
			const trimmed = text.trim();
			const hasImages = Boolean(options?.images && options.images.length > 0);
			if ((!trimmed && !hasImages) || !onSendMessage) {
				return false;
			}

			setError(null);
			setIsSending(true);

			try {
				const result = options
					? await onSendMessage(taskId, trimmed, options)
					: await onSendMessage(taskId, trimmed);
				if (!result.ok) {
					const message = result.message ?? "Could not send message.";
					setError(message);
					return false;
				}
				const sentMessage = result.chatMessage ?? null;
				if (sentMessage) {
					setMessages((currentMessages) => upsertMessage(currentMessages, sentMessage));
				} else if (onLoadMessages) {
					const loadedMessages = await onLoadMessages(taskId);
					setMessages(loadedMessages ?? []);
				}
				return true;
			} catch (sendError) {
				const message = sendError instanceof Error ? sendError.message : String(sendError);
				setError(message);
				return false;
			} finally {
				setIsSending(false);
			}
		},
		[onLoadMessages, onSendMessage, taskId],
	);

	return {
		messages,
		isSending: isSending || isLoading,
		isLoadingHistory: isLoading,
		isCanceling,
		error,
		sendMessage,
		cancelTurn,
	};
}
