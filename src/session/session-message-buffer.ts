// Agent-agnostic streaming buffer for session transcripts.
//
// Holds the ordered `SessionMessage[]` plus the per-turn cursors needed to fold
// streaming deltas (assistant text, reasoning, tool calls) into stable message
// objects. Any agent runtime — pi today, CLI/terminal transcripts later — can
// own a `SessionMessageBuffer` and reuse these mutation helpers instead of
// reimplementing streaming reconciliation.
import { createSessionMessage, createSessionMessageWithMeta, type SessionMessage } from "./session-message";

export interface SessionMessageBuffer {
	messages: SessionMessage[];
	activeAssistantMessageId: string | null;
	activeReasoningMessageId: string | null;
	toolMessageIdByToolCallId: Map<string, string>;
	toolInputByToolCallId: Map<string, unknown>;
}

export function createSessionMessageBuffer(): SessionMessageBuffer {
	return {
		messages: [],
		activeAssistantMessageId: null,
		activeReasoningMessageId: null,
		toolMessageIdByToolCallId: new Map<string, string>(),
		toolInputByToolCallId: new Map<string, unknown>(),
	};
}

export function clearActiveTurnState(buffer: SessionMessageBuffer): void {
	buffer.activeAssistantMessageId = null;
	buffer.activeReasoningMessageId = null;
	buffer.toolMessageIdByToolCallId.clear();
	buffer.toolInputByToolCallId.clear();
}

export function latestAssistantMessageMatches(buffer: SessionMessageBuffer, content: string): boolean {
	const latestAssistant = getLatestAssistantMessage(buffer);
	if (!latestAssistant) {
		return false;
	}
	return latestAssistant.content.trim() === content.trim();
}

export function appendAssistantChunk(buffer: SessionMessageBuffer, taskId: string, chunk: string): SessionMessage {
	const existingMessageId = buffer.activeAssistantMessageId;
	if (existingMessageId) {
		const updatedMessage = updateMessageInBuffer(buffer, existingMessageId, (currentMessage) => ({
			...currentMessage,
			content: `${currentMessage.content}${chunk}`,
		}));
		if (updatedMessage) {
			return updatedMessage;
		}
	}
	return createAssistantMessage(buffer, taskId, chunk);
}

export function setOrCreateAssistantMessage(
	buffer: SessionMessageBuffer,
	taskId: string,
	content: string,
): SessionMessage | null {
	if (!buffer.activeAssistantMessageId) {
		return null;
	}
	const updatedMessage = updateMessageInBuffer(buffer, buffer.activeAssistantMessageId, (currentMessage) => ({
		...currentMessage,
		content,
	}));
	if (updatedMessage) {
		return updatedMessage;
	}
	return createAssistantMessage(buffer, taskId, content);
}

export function appendReasoningChunk(buffer: SessionMessageBuffer, taskId: string, chunk: string): SessionMessage {
	const existingMessageId = buffer.activeReasoningMessageId;
	if (existingMessageId) {
		const updatedMessage = updateMessageInBuffer(buffer, existingMessageId, (currentMessage) => ({
			...currentMessage,
			content: `${currentMessage.content}${chunk}`,
			meta: {
				...(currentMessage.meta ?? {}),
				hookEventName: "reasoning_delta",
				streamType: "reasoning",
			},
		}));
		if (updatedMessage) {
			return updatedMessage;
		}
	}
	return createReasoningMessage(buffer, taskId, chunk, "reasoning_delta");
}

export function setOrCreateReasoningMessage(
	buffer: SessionMessageBuffer,
	taskId: string,
	content: string,
): SessionMessage | null {
	if (!buffer.activeReasoningMessageId) {
		return null;
	}
	const updatedMessage = updateMessageInBuffer(buffer, buffer.activeReasoningMessageId, (currentMessage) => ({
		...currentMessage,
		content,
		meta: {
			...(currentMessage.meta ?? {}),
			hookEventName: "reasoning_end",
			streamType: "reasoning",
		},
	}));
	if (updatedMessage) {
		return updatedMessage;
	}
	return createReasoningMessage(buffer, taskId, content, "reasoning_end");
}

export function createAssistantMessage(buffer: SessionMessageBuffer, taskId: string, content: string): SessionMessage {
	const message = createSessionMessage(taskId, "assistant", content);
	buffer.messages.push(message);
	buffer.activeAssistantMessageId = message.id;
	return message;
}

export function createReasoningMessage(
	buffer: SessionMessageBuffer,
	taskId: string,
	content: string,
	hookEventName: string,
): SessionMessage {
	const message = createSessionMessageWithMeta(taskId, "reasoning", content, {
		hookEventName,
		streamType: "reasoning",
	});
	buffer.messages.push(message);
	buffer.activeReasoningMessageId = message.id;
	return message;
}

export function startToolCallMessage(
	buffer: SessionMessageBuffer,
	taskId: string,
	input: {
		toolName: string | null;
		toolCallId: string | null;
		input: unknown;
	},
): SessionMessage {
	const toolContent = buildToolCallContent({
		toolName: input.toolName,
		input: input.input,
	});
	const message = createSessionMessageWithMeta(taskId, "tool", toolContent, {
		toolName: input.toolName,
		hookEventName: "tool_call_start",
		toolCallId: input.toolCallId,
		streamType: "tool",
	});
	buffer.messages.push(message);
	if (input.toolCallId) {
		buffer.toolMessageIdByToolCallId.set(input.toolCallId, message.id);
		buffer.toolInputByToolCallId.set(input.toolCallId, input.input);
	}
	return message;
}

export function finishToolCallMessage(
	buffer: SessionMessageBuffer,
	taskId: string,
	input: {
		toolName: string | null;
		toolCallId: string | null;
		output: unknown;
		error: string | null;
		durationMs: number | null;
	},
): SessionMessage {
	const existingMessageId = input.toolCallId ? (buffer.toolMessageIdByToolCallId.get(input.toolCallId) ?? null) : null;
	const toolInput = input.toolCallId ? buffer.toolInputByToolCallId.get(input.toolCallId) : undefined;
	const content = buildToolCallContent({
		toolName: input.toolName,
		input: toolInput,
		output: input.output,
		error: input.error,
		durationMs: input.durationMs,
	});
	if (existingMessageId) {
		const updatedMessage = updateMessageInBuffer(buffer, existingMessageId, (currentMessage) => ({
			...currentMessage,
			content,
			meta: {
				...(currentMessage.meta ?? {}),
				toolName: input.toolName,
				hookEventName: "tool_call_end",
				toolCallId: input.toolCallId,
				streamType: "tool",
			},
		}));
		if (updatedMessage) {
			if (input.toolCallId) {
				buffer.toolMessageIdByToolCallId.delete(input.toolCallId);
				buffer.toolInputByToolCallId.delete(input.toolCallId);
			}
			return updatedMessage;
		}
	}
	const message = createSessionMessageWithMeta(taskId, "tool", content, {
		toolName: input.toolName,
		hookEventName: "tool_call_end",
		toolCallId: input.toolCallId,
		streamType: "tool",
	});
	if (input.toolCallId) {
		buffer.toolMessageIdByToolCallId.delete(input.toolCallId);
		buffer.toolInputByToolCallId.delete(input.toolCallId);
	}
	buffer.messages.push(message);
	return message;
}

function stringifyPayload(payload: unknown): string {
	if (payload === undefined || payload === null) {
		return "";
	}
	if (typeof payload === "string") {
		return payload;
	}
	try {
		return JSON.stringify(payload, null, 2);
	} catch {
		return String(payload);
	}
}

function buildToolCallContent(input: {
	toolName: string | null;
	input: unknown;
	output?: unknown;
	error?: string | null;
	durationMs?: number | null;
}): string {
	const lines: string[] = [];
	lines.push(`Tool: ${input.toolName ?? "unknown"}`);
	const inputText = stringifyPayload(input.input);
	if (inputText) {
		lines.push("Input:");
		lines.push(inputText);
	}
	if (input.error) {
		lines.push("Error:");
		lines.push(input.error);
	} else if (input.output !== undefined) {
		const outputText = stringifyPayload(input.output);
		if (outputText) {
			lines.push("Output:");
			lines.push(outputText);
		}
	}
	if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
		lines.push(`Duration: ${Math.max(0, Math.round(input.durationMs))}ms`);
	}
	return lines.join("\n");
}

function updateMessageInBuffer(
	buffer: SessionMessageBuffer,
	messageId: string,
	updater: (currentMessage: SessionMessage) => SessionMessage,
): SessionMessage | null {
	const messageIndex = buffer.messages.findIndex((message) => message.id === messageId);
	if (messageIndex < 0) {
		return null;
	}
	const currentMessage = buffer.messages[messageIndex];
	if (!currentMessage) {
		return null;
	}
	const nextMessage = updater(currentMessage);
	buffer.messages[messageIndex] = nextMessage;
	return nextMessage;
}

function getLatestAssistantMessage(buffer: SessionMessageBuffer): SessionMessage | null {
	for (let index = buffer.messages.length - 1; index >= 0; index -= 1) {
		const message = buffer.messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}
	return null;
}
