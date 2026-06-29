// Pure decision logic for recovering a terminal (PTY-backed) agent session whose
// process died with the runtime (force-kill / crash). The terminal panel only
// *attaches* to a session over websockets; nothing relaunches a dead PTY, so
// reopening such a task otherwise gets stuck on "Terminal stream closed". These
// helpers decide whether reopening should relaunch the session and what to tell
// the user about whether the prior conversation can be resumed.
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";

import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";

// A live PTY backs the session only in these two states. Everything else
// (idle/interrupted/failed/exit) means the process is gone.
export function isTerminalSessionLive(summary: RuntimeTaskSessionSummary): boolean {
	return summary.state === "running" || summary.state === "awaiting_review";
}

// Terminal (PTY-backed) agents are every agent except the native "pi" agent,
// which renders a chat panel rather than a terminal and has its own resume path.
export function isTerminalAgentId(agentId: RuntimeAgentId | null | undefined): agentId is RuntimeAgentId {
	return agentId != null && agentId !== "pi";
}

// Active board columns are the only ones whose tasks were actually running an
// agent. A dead session here means the runtime died mid-task; backlog/done/trash
// must never auto-spawn an agent just because the user opened the card.
const ACTIVE_TERMINAL_COLUMN_IDS = new Set(["in_progress", "review"]);

export function shouldAutoRelaunchTerminalSession(input: {
	summary: RuntimeTaskSessionSummary | null;
	columnId: string | null | undefined;
}): boolean {
	const { summary, columnId } = input;
	if (!summary) {
		return false;
	}
	if (!columnId || !ACTIVE_TERMINAL_COLUMN_IDS.has(columnId)) {
		return false;
	}
	if (!isTerminalAgentId(summary.agentId)) {
		return false;
	}
	return !isTerminalSessionLive(summary);
}

export interface TerminalReconnectPlan {
	/**
	 * True when the agent recorded a Kanban-pinned session id, so relaunch resumes
	 * the original conversation (claude/qoder `--resume`, codex `resume <id>`).
	 * False for agents with no per-session id (gemini/droid/kiro/opencode): relaunch
	 * starts a fresh session — the worktree files survive, the conversation does not.
	 */
	willResumeConversation: boolean;
	/** A one-line note to surface to the user, or null when resume is seamless. */
	noticeMessage: string | null;
}

export function describeTerminalReconnect(summary: RuntimeTaskSessionSummary): TerminalReconnectPlan {
	if (summary.agentSessionId) {
		return { willResumeConversation: true, noticeMessage: null };
	}
	const agentLabel = isTerminalAgentId(summary.agentId)
		? (getRuntimeAgentCatalogEntry(summary.agentId)?.label ?? summary.agentId)
		: "this agent";
	return {
		willResumeConversation: false,
		noticeMessage: `Previous ${agentLabel} conversation couldn't be resumed after the restart. Started a fresh session — your worktree files are intact.`,
	};
}
