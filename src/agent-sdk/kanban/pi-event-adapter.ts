// Maps omp AgentEvent union type to Kanban RuntimeTaskSessionSummary.
import type { RuntimeTaskSessionSummary, RuntimeTaskSessionUsage } from "../../core/api-contract";
import { now, type SessionMessage } from "../../session/session-message";
import {
	clearActiveTurnState,
	createAssistantMessage,
	finishToolCallMessage,
	setOrCreateAssistantMessage,
	startToolCallMessage,
} from "../../session/session-message-buffer";
import type { AgentEvent, AgentMessage } from "../types";
import { type KanbanTaskSessionEntry, updateSummary } from "./session-state";

export interface ApplyPiAgentEventInput {
	event: AgentEvent;
	taskId: string;
	entry: KanbanTaskSessionEntry;
	pendingTurnCancelTaskIds: Set<string>;
	emitSummary: (summary: RuntimeTaskSessionSummary) => void;
	emitMessage: (taskId: string, message: SessionMessage) => void;
}

/**
 * Translate omp AgentEvent into Kanban summary and chat mutations.
 */
export function applyPiAgentEvent(input: ApplyPiAgentEventInput): void {
	const { event } = input;

	switch (event.type) {
		case "agent_start":
			handleAgentStart(input);
			break;
		case "agent_end":
			handleAgentEnd(input, event);
			break;
		case "turn_start":
			handleTurnStart(input);
			break;
		case "turn_end":
			handleTurnEnd(input, event);
			break;
		case "message_start":
			handleMessageStart(input, event);
			break;
		case "message_update":
			handleMessageUpdate(input, event);
			break;
		case "message_end":
			handleMessageEnd(input, event);
			break;
		case "tool_execution_start":
			handleToolExecutionStart(input, event);
			break;
		case "tool_execution_update":
			handleToolExecutionUpdate(input, event);
			break;
		case "tool_execution_end":
			handleToolExecutionEnd(input, event);
			break;
	}
}

function handleAgentStart(input: ApplyPiAgentEventInput): void {
	emitSummary(input, {
		state: "running",
		lastOutputAt: now(),
		lastHookAt: now(),
		latestHookActivity: {
			activityText: "Agent active",
			toolName: null,
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "agent_start",
			notificationType: null,
			source: "pi-agent",
		},
	});
}

function handleAgentEnd(input: ApplyPiAgentEventInput, event: Extract<AgentEvent, { type: "agent_end" }>): void {
	const { entry, taskId } = input;
	const isCanceled = input.pendingTurnCancelTaskIds.has(taskId);

	if (isCanceled) {
		input.pendingTurnCancelTaskIds.delete(taskId);
		clearActiveTurnState(entry);
		emitSummary(input, {
			state: "idle",
			reviewReason: null,
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: "Turn canceled",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "turn_canceled",
				notificationType: null,
				source: "pi-agent",
			},
		});
		return;
	}

	// Fold this run's token telemetry into the session's cumulative usage. omp
	// reports per-run usage on `agent_end`; summing across runs yields the
	// session total. Absent telemetry leaves the prior total untouched.
	const usage = accumulateUsage(entry.summary.usage, event.telemetry);

	// Check if the agent ended with an error (empty text + errorMessage field)
	const errorInfo = extractErrorFromMessages(event.messages);

	// Extract final text from the last assistant message in the event
	const finalText = extractFinalText(event.messages);

	// Don't create a new assistant message if streaming events already did.
	// The message_end handler already set the final text and cleared activeAssistantMessageId.
	// We only need to create a message here if:
	// - There's an error (no streaming happened, just a failure)
	// - No messages exist yet (edge case: agent_end without prior streaming)
	if (finalText && entry.messages.length === 0) {
		const message = createAssistantMessage(entry, taskId, finalText);
		input.emitMessage(taskId, message);
	} else if (errorInfo) {
		// Agent failed — surface the error as a visible chat message
		const errorMessage = createAssistantMessage(entry, taskId, `Agent error: ${errorInfo}`);
		input.emitMessage(taskId, errorMessage);
	}

	clearActiveTurnState(entry);

	if (errorInfo && !finalText) {
		// Error path: show warning to user
		emitSummary(input, {
			state: "awaiting_review",
			reviewReason: "error",
			warningMessage: errorInfo,
			lastOutputAt: now(),
			lastHookAt: now(),
			...(usage ? { usage } : {}),
			latestHookActivity: {
				activityText: `Error: ${truncate(errorInfo, 160)}`,
				toolName: null,
				toolInputSummary: null,
				finalMessage: errorInfo,
				hookEventName: "agent_error",
				notificationType: null,
				source: "pi-agent",
			},
		});
	} else {
		emitSummary(input, {
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: now(),
			lastHookAt: now(),
			...(usage ? { usage } : {}),
			latestHookActivity: {
				activityText: finalText ? `Final: ${truncate(finalText, 160)}` : "Agent finished",
				toolName: null,
				toolInputSummary: null,
				finalMessage: finalText ?? null,
				hookEventName: "agent_end",
				notificationType: null,
				source: "pi-agent",
			},
		});
	}
}

/**
 * Accumulate a run's omp token telemetry onto the session's running total. Returns
 * the prior total unchanged when this run carried no telemetry, and `undefined`
 * when there is nothing to record yet (so callers can omit the field).
 */
function accumulateUsage(
	prev: RuntimeTaskSessionSummary["usage"],
	telemetry: Extract<AgentEvent, { type: "agent_end" }>["telemetry"],
): RuntimeTaskSessionUsage | undefined {
	if (!telemetry) {
		return prev ?? undefined;
	}
	const base = prev ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
	return {
		inputTokens: base.inputTokens + telemetry.usage.inputTokens,
		outputTokens: base.outputTokens + telemetry.usage.outputTokens,
		totalTokens: base.totalTokens + telemetry.usage.totalTokens,
	};
}

function handleTurnStart(input: ApplyPiAgentEventInput): void {
	emitSummary(input, {
		state: "running",
		lastOutputAt: now(),
		lastHookAt: now(),
		latestHookActivity: {
			activityText: "Agent active",
			toolName: null,
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "turn_start",
			notificationType: null,
			source: "pi-agent",
		},
	});
}

function handleTurnEnd(input: ApplyPiAgentEventInput, event: Extract<AgentEvent, { type: "turn_end" }>): void {
	const { entry, taskId } = input;

	// Extract assistant text from the turn_end message.
	// Do NOT create a new message here — streaming events (message_start/update/end)
	// already created and finalized the assistant message. turn_end is just for
	// processing tool results and updating the summary.
	const text = extractTextFromMessage(event.message);

	// Process tool results
	for (const toolResult of event.toolResults) {
		const toolName = extractToolName(toolResult);
		const toolCallId = extractToolCallId(toolResult);
		input.emitMessage(
			taskId,
			finishToolCallMessage(entry, taskId, {
				toolName,
				toolCallId,
				output: extractToolResultOutput(toolResult),
				error: null,
				durationMs: null,
			}),
		);
	}

	clearActiveTurnState(entry);
	emitSummary(input, {
		lastOutputAt: now(),
		lastHookAt: now(),
		latestHookActivity: {
			activityText: text ? truncate(text, 160) : "Turn complete",
			toolName: null,
			toolInputSummary: null,
			finalMessage: text ?? null,
			hookEventName: "turn_end",
			notificationType: null,
			source: "pi-agent",
		},
	});
}

function handleMessageStart(
	input: ApplyPiAgentEventInput,
	event: Extract<AgentEvent, { type: "message_start" }>,
): void {
	if (isAssistantMessage(event.message)) {
		// Always create the assistant message so activeAssistantMessageId is set
		// for subsequent streaming updates, even if initial text is empty.
		const text = extractTextFromMessage(event.message) ?? "";
		const message = createAssistantMessage(input.entry, input.taskId, text);
		if (text) {
			input.emitMessage(input.taskId, message);
		}
	}
}

function handleMessageUpdate(
	input: ApplyPiAgentEventInput,
	event: Extract<AgentEvent, { type: "message_update" }>,
): void {
	if (!isAssistantMessage(event.message)) return;

	// The omp Agent's message_update carries the FULL accumulated text so far
	// (not a delta), so we must SET (replace) the message content, not append.
	const text = extractTextFromMessage(event.message);
	if (text) {
		// Fallback: if message_start didn't create a message (empty initial text),
		// create one now so the streaming text is visible.
		let message = setOrCreateAssistantMessage(input.entry, input.taskId, text);
		if (!message) {
			message = createAssistantMessage(input.entry, input.taskId, text);
		}
		input.emitMessage(input.taskId, message);
		emitSummary(input, {
			state: "running",
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: truncate(text, 160) || "Agent active",
				toolName: null,
				toolInputSummary: null,
				finalMessage: text,
				hookEventName: "assistant_delta",
				notificationType: null,
				source: "pi-agent",
			},
		});
	}
}

function handleMessageEnd(input: ApplyPiAgentEventInput, event: Extract<AgentEvent, { type: "message_end" }>): void {
	if (!isAssistantMessage(event.message)) return;

	const text = extractTextFromMessage(event.message);
	if (text) {
		// Finalize: set the complete accumulated text
		let message = setOrCreateAssistantMessage(input.entry, input.taskId, text);
		if (!message) {
			message = createAssistantMessage(input.entry, input.taskId, text);
		}
		input.emitMessage(input.taskId, message);
		emitSummary(input, {
			state: "running",
			lastOutputAt: now(),
		});
	}
	input.entry.activeAssistantMessageId = null;
}

function handleToolExecutionStart(
	input: ApplyPiAgentEventInput,
	event: Extract<AgentEvent, { type: "tool_execution_start" }>,
): void {
	const { entry, taskId } = input;
	input.emitMessage(
		taskId,
		startToolCallMessage(entry, taskId, {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			input: event.args,
		}),
	);

	const inputSummary = summarizeToolInput(event.args);
	emitSummary(input, {
		lastOutputAt: now(),
		lastHookAt: now(),
		latestHookActivity: {
			activityText: `Using ${event.toolName}${inputSummary ? ` (${inputSummary})` : ""}`,
			toolName: event.toolName,
			toolInputSummary: inputSummary,
			finalMessage: null,
			hookEventName: "tool_call",
			notificationType: null,
			source: "pi-agent",
		},
	});
}

function handleToolExecutionUpdate(
	input: ApplyPiAgentEventInput,
	_event: Extract<AgentEvent, { type: "tool_execution_update" }>,
): void {
	// Tool execution updates are mainly for progress display.
	// We update the lastOutputAt to show activity.
	emitSummary(input, {
		lastOutputAt: now(),
	});
}

function handleToolExecutionEnd(
	input: ApplyPiAgentEventInput,
	event: Extract<AgentEvent, { type: "tool_execution_end" }>,
): void {
	const { entry, taskId } = input;
	const isError = event.isError === true;
	const outputSummary = summarizeToolResult(event.result);

	input.emitMessage(
		taskId,
		finishToolCallMessage(entry, taskId, {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			output: event.result,
			error: isError ? (outputSummary ?? "Tool execution failed") : null,
			durationMs: null,
		}),
	);

	emitSummary(input, {
		lastOutputAt: now(),
		lastHookAt: now(),
		latestHookActivity: {
			activityText: `${isError ? "Failed" : "Completed"} ${event.toolName}`,
			toolName: event.toolName,
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "tool_result",
			notificationType: null,
			source: "pi-agent",
		},
	});
}

// --- Helpers ---

function emitSummary(input: ApplyPiAgentEventInput, patch: Partial<RuntimeTaskSessionSummary>): void {
	input.emitSummary(updateSummary(input.entry, patch));
}

function isAssistantMessage(message: AgentMessage): boolean {
	return message && typeof message === "object" && "role" in message && message.role === "assistant";
}

function extractTextFromMessage(message: AgentMessage): string | null {
	if (!message || typeof message !== "object" || !("content" in message)) return null;
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(part: any) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string",
			)
			.map((part: any) => part.text)
			.join("");
	}
	return null;
}

function extractFinalText(messages: AgentMessage[]): string | null {
	// Find the last assistant message and extract its text
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg && isAssistantMessage(msg)) {
			const text = extractTextFromMessage(msg);
			if (text) return text;
		}
	}
	return null;
}

function extractErrorFromMessages(messages: AgentMessage[]): string | null {
	// Check if any message in the event has an errorMessage field (error from agent)
	for (const msg of messages) {
		if (msg && typeof msg === "object" && "errorMessage" in msg) {
			const err = (msg as any).errorMessage;
			if (typeof err === "string" && err.trim()) {
				return err.trim();
			}
		}
		if (msg && typeof msg === "object" && "stopReason" in msg) {
			const reason = (msg as any).stopReason;
			if (reason === "error") {
				// Error stop with no errorMessage — generic failure
				return "Agent encountered an unexpected error.";
			}
		}
	}
	return null;
}

function extractToolName(toolResult: any): string | null {
	if (!toolResult) return null;
	if (typeof toolResult.toolName === "string") return toolResult.toolName;
	if (typeof toolResult.name === "string") return toolResult.name;
	return null;
}

function extractToolCallId(toolResult: any): string | null {
	if (!toolResult) return null;
	if (typeof toolResult.toolCallId === "string") return toolResult.toolCallId;
	if (typeof toolResult.id === "string") return toolResult.id;
	return null;
}

function extractToolResultOutput(toolResult: any): unknown {
	if (!toolResult) return undefined;
	if ("content" in toolResult) return toolResult.content;
	if ("output" in toolResult) return toolResult.output;
	if ("result" in toolResult) return toolResult.result;
	return toolResult;
}

function truncate(text: string, maxLen: number): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (trimmed.length <= maxLen) return trimmed;
	return `${trimmed.slice(0, maxLen - 1).trimEnd()}…`;
}

function summarizeToolInput(args: any): string | null {
	if (!args || typeof args !== "object") return null;
	const path = args.path ?? args.file ?? args.filePath;
	if (path) return String(path);
	const command = args.command ?? args.cmd;
	if (command) return truncate(String(command), 80);
	const pattern = args.pattern ?? args.query;
	if (pattern) return truncate(String(pattern), 80);
	return null;
}

function summarizeToolResult(result: any): string | null {
	if (!result) return null;
	if (typeof result === "string") return truncate(result, 200);
	if (typeof result === "object" && "content" in result) {
		const content = result.content;
		if (Array.isArray(content)) {
			const text = content
				.filter((part: any) => part?.type === "text" && typeof part.text === "string")
				.map((part: any) => part.text)
				.join("");
			return text ? truncate(text, 200) : null;
		}
	}
	return null;
}
