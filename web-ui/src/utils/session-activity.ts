// Pure, side-effect-free derivation of a short "live activity" line from an
// agent session summary — the single source of truth shared by the board task
// card (board-card.tsx) and the fullscreen Home-tab session card
// (home-agent/home-session-card.tsx).
//
// It collapses the rich `latestHookActivity` stream + session state into a
// one-line status ("Thinking…", a compact tool-call label like "Read(file)",
// "Waiting for review", an error/credit message, …) plus a dot color, so both
// cards render the same colored-dot + monospace row from one implementation.
import { formatKanbanToolCallLabel } from "@runtime-kanban-tool-call-display";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export interface CardSessionActivity {
	dotColor: string;
	text: string;
}

export const SESSION_ACTIVITY_COLOR = {
	thinking: "var(--color-status-blue)",
	success: "var(--color-status-green)",
	waiting: "var(--color-status-gold)",
	error: "var(--color-status-red)",
	warning: "var(--color-status-orange)",
	muted: "var(--color-text-tertiary)",
	secondary: "var(--color-text-secondary)",
} as const;

function extractToolInputSummaryFromActivityText(activityText: string, toolName: string): string | null {
	const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = activityText.match(
		new RegExp(`^(?:Using|Completed|Failed|Calling)\\s+${escapedToolName}(?::\\s*(.+))?$`),
	);
	if (!match) {
		return null;
	}
	const rawSummary = match[1]?.trim() ?? "";
	if (!rawSummary) {
		return null;
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return operationSummary?.trim() || null;
	}
	return rawSummary;
}

function parseToolCallFromActivityText(
	activityText: string,
): { toolName: string; toolInputSummary: string | null } | null {
	const match = activityText.match(/^(?:Using|Completed|Failed|Calling)\s+([^:()]+?)(?::\s*(.+))?$/);
	if (!match?.[1]) {
		return null;
	}
	const toolName = match[1].trim();
	if (!toolName) {
		return null;
	}
	const rawSummary = match[2]?.trim() ?? "";
	if (!rawSummary) {
		return { toolName, toolInputSummary: null };
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return {
			toolName,
			toolInputSummary: operationSummary?.trim() || null,
		};
	}
	return {
		toolName,
		toolInputSummary: rawSummary,
	};
}

function resolveToolCallLabel(
	activityText: string | undefined,
	toolName: string | null,
	toolInputSummary: string | null,
): string | null {
	if (toolName) {
		const parsedSummary = extractToolInputSummaryFromActivityText(activityText ?? "", toolName);
		if (!toolInputSummary && !parsedSummary) {
			return null;
		}
		return formatKanbanToolCallLabel(toolName, toolInputSummary ?? parsedSummary);
	}
	if (!activityText) {
		return null;
	}
	const parsed = parseToolCallFromActivityText(activityText);
	if (!parsed) {
		return null;
	}
	return formatKanbanToolCallLabel(parsed.toolName, parsed.toolInputSummary);
}

/**
 * True when the session ended/paused because the agent's provider ran out of
 * credits. Surfaced as a distinct warning state by both cards.
 */
export function isCardCreditLimitError(summary: RuntimeTaskSessionSummary | undefined | null): boolean {
	if (!summary) {
		return false;
	}
	if (summary.state !== "awaiting_review" && summary.state !== "failed" && summary.state !== "interrupted") {
		return false;
	}
	return summary.latestHookActivity?.notificationType === "credit_limit";
}

/**
 * Derive a one-line live-activity descriptor (dot color + text) from a session
 * summary, or null when there's nothing live to show (no summary / idle with no
 * hook activity). Shared by the board task card and the home session card so
 * both read identically.
 */
export function getCardSessionActivity(
	summary: RuntimeTaskSessionSummary | undefined | null,
): CardSessionActivity | null {
	if (!summary) {
		return null;
	}
	if (isCardCreditLimitError(summary)) {
		return { dotColor: SESSION_ACTIVITY_COLOR.warning, text: "Out of credits" };
	}
	const hookActivity = summary.latestHookActivity;
	const rawActivityText = hookActivity?.activityText?.trim();
	// "Agent active" / "Working on task" / "Resumed…" are running-indicators set
	// while a turn is in flight. Terminal agents (Claude/Codex/…) end a turn via a
	// hook that carries no final message, so this text is never overwritten and
	// lingers after the session settles into awaiting_review/idle. Honoring it once
	// the agent is no longer running makes an idle session read as "Thinking…", so
	// drop it unless the session is genuinely running — the derivation then falls
	// back to the state-based label (e.g. "Waiting for review").
	const isRunningIndicator =
		rawActivityText === "Agent active" ||
		rawActivityText === "Working on task" ||
		(rawActivityText?.startsWith("Resumed") ?? false);
	const activityText = isRunningIndicator && summary.state !== "running" ? undefined : rawActivityText;
	const toolName = hookActivity?.toolName?.trim() ?? null;
	const toolInputSummary = hookActivity?.toolInputSummary?.trim() ?? null;
	const finalMessage = hookActivity?.finalMessage?.trim();
	const hookEventName = hookActivity?.hookEventName?.trim() ?? null;
	if (summary.state === "awaiting_review" && finalMessage) {
		return { dotColor: SESSION_ACTIVITY_COLOR.success, text: finalMessage };
	}
	if (
		finalMessage &&
		!toolName &&
		(hookEventName === "assistant_delta" || hookEventName === "agent_end" || hookEventName === "turn_start")
	) {
		return {
			dotColor: summary.state === "running" ? SESSION_ACTIVITY_COLOR.thinking : SESSION_ACTIVITY_COLOR.success,
			text: finalMessage,
		};
	}
	if (activityText) {
		let dotColor: string =
			summary.state === "failed" ? SESSION_ACTIVITY_COLOR.error : SESSION_ACTIVITY_COLOR.thinking;
		let text = activityText;
		const toolCallLabel = resolveToolCallLabel(activityText, toolName, toolInputSummary);
		if (toolCallLabel) {
			if (text.startsWith("Failed ")) {
				dotColor = SESSION_ACTIVITY_COLOR.error;
			}
			return {
				dotColor,
				text: toolCallLabel,
			};
		}
		if (text.startsWith("Final: ")) {
			dotColor = SESSION_ACTIVITY_COLOR.success;
			text = text.slice(7);
		} else if (text.startsWith("Agent: ")) {
			text = text.slice(7);
		} else if (text.startsWith("Waiting for approval")) {
			dotColor = SESSION_ACTIVITY_COLOR.waiting;
		} else if (text.startsWith("Waiting for review")) {
			dotColor = SESSION_ACTIVITY_COLOR.success;
		} else if (text.startsWith("Failed ")) {
			dotColor = SESSION_ACTIVITY_COLOR.error;
		} else if (text === "Agent active" || text === "Working on task" || text.startsWith("Resumed")) {
			return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
		}
		return { dotColor, text };
	}
	if (summary.state === "failed") {
		const failedText = finalMessage ?? activityText ?? "Task failed to start";
		return { dotColor: SESSION_ACTIVITY_COLOR.error, text: failedText };
	}
	if (summary.state === "awaiting_review") {
		return { dotColor: SESSION_ACTIVITY_COLOR.success, text: "Waiting for review" };
	}
	if (summary.state === "running") {
		return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
	}
	return null;
}
