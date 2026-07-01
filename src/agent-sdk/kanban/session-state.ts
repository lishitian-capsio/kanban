// Pure state helpers for pi task session management.
//
// The agent-agnostic transcript model and streaming buffer now live in
// `src/session/` (session-message.ts / session-message-buffer.ts). This module
// keeps the pi-specific pieces: the in-memory session entry (buffer + summary)
// and the `RuntimeTaskSessionSummary` lifecycle/session-id helpers shared by the
// event adapter and the task session service.
import type { RuntimeTaskSessionSummary } from "../../core/api-contract";
import { now } from "../../session/session-message";
import { createSessionMessageBuffer, type SessionMessageBuffer } from "../../session/session-message-buffer";

const USER_ATTENTION_TOOL_NAMES = new Set(["ask_followup_question", "plan_mode_respond"]);

/**
 * Detect credit-limit / insufficient-balance errors from an error message string.
 * Shared by the event adapter (for SDK agent events) and the session service (for
 * start/send failures) so the detection logic stays in one place.
 */
const CREDIT_LIMIT_PATTERNS = [
	"insufficient balance",
	"insufficient_credits",
	"insufficient credits",
	"credit limit",
	"credit_limit_exceeded",
	"credits exhausted",
	"out of credits",
	"no remaining credits",
	"402 payment required",
] as const;

export function isCreditLimitError(errorMessage: string | null): boolean {
	if (!errorMessage) {
		return false;
	}
	const normalized = errorMessage.toLowerCase();
	if (CREDIT_LIMIT_PATTERNS.some((pattern) => normalized.includes(pattern))) {
		return true;
	}
	return normalized.includes("402") && (normalized.includes("balance") || normalized.includes("credit"));
}

const WINDOWS_INVALID_SESSION_ID_CHARS = /[<>:"/\\|?*]/g;

/**
 * In-memory pi session entry: the agent-agnostic message buffer plus the pi
 * runtime summary that tracks lifecycle/review state for the task.
 */
export interface KanbanTaskSessionEntry extends SessionMessageBuffer {
	summary: RuntimeTaskSessionSummary;
}

export function createKanbanTaskSessionEntry(summary: RuntimeTaskSessionSummary): KanbanTaskSessionEntry {
	return {
		...createSessionMessageBuffer(),
		summary,
	};
}

export function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
		latestHookActivity: summary.latestHookActivity ? { ...summary.latestHookActivity } : null,
		latestTurnCheckpoint: summary.latestTurnCheckpoint ? { ...summary.latestTurnCheckpoint } : null,
		previousTurnCheckpoint: summary.previousTurnCheckpoint ? { ...summary.previousTurnCheckpoint } : null,
		subagents: summary.subagents ? summary.subagents.map((subagent) => ({ ...subagent })) : summary.subagents,
	};
}

export function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		mode: null,
		agentId: "pi",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		providerId: null,
		modelId: null,
		usage: null,
		subagents: null,
	};
}

export function updateSummary(
	entry: KanbanTaskSessionEntry,
	patch: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	entry.summary = {
		...entry.summary,
		...patch,
		updatedAt: now(),
	};
	return cloneSummary(entry.summary);
}

export function createSessionId(taskId: string): string {
	return `${toSessionIdTaskPrefix(taskId)}-${now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildSessionIdPrefix(taskId: string): string {
	return `${toSessionIdTaskPrefix(taskId)}-`;
}

function toSessionIdTaskPrefix(taskId: string): string {
	const normalized = taskId.replace(WINDOWS_INVALID_SESSION_ID_CHARS, "_").trim();
	return normalized.length > 0 ? normalized : "session";
}

export function isKanbanUserAttentionTool(toolName: string | null): boolean {
	if (!toolName) {
		return false;
	}
	return USER_ATTENTION_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

export function canReturnToRunning(reviewReason: RuntimeTaskSessionSummary["reviewReason"]): boolean {
	return reviewReason === "attention" || reviewReason === "hook" || reviewReason === "error";
}
