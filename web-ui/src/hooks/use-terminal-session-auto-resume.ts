// Auto-relaunches a terminal (PTY-backed) agent session when the user reopens a
// task whose process died with the runtime (force-kill / crash). The terminal
// panel only attaches over websockets, so without this a reopened crashed task
// stays stuck on "Terminal stream closed". Resume-capable agents reattach their
// conversation; others start a fresh session (worktree files survive) with a note.
import { useCallback, useEffect, useRef } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	describeTerminalReconnect,
	isTerminalSessionLive,
	shouldAutoRelaunchTerminalSession,
} from "@/terminal/terminal-session-reconnect";
import type { CardSelection } from "@/types/board";

interface UseTerminalSessionAutoResumeInput {
	selectedCard: CardSelection | null;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	enabled: boolean;
}

export function useTerminalSessionAutoResume({
	selectedCard,
	sessions,
	startTaskSession,
	enabled,
}: UseTerminalSessionAutoResumeInput): void {
	// Tasks we've already fired a relaunch for, so a stream of session-summary
	// updates doesn't spawn the agent repeatedly. Cleared per task when the user
	// navigates away (reopening should retry) or when the session goes live again.
	const attemptedTaskIdsRef = useRef<Set<string>>(new Set());
	const previousSelectedTaskIdRef = useRef<string | null>(null);

	const relaunch = useCallback(
		async (selection: CardSelection, summary: RuntimeTaskSessionSummary) => {
			const taskId = selection.card.id;
			const plan = describeTerminalReconnect(summary);
			const result = await startTaskSession(selection.card, { reconnect: true });
			if (!result.ok) {
				// Allow a later retry (e.g. user reopens) rather than wedging on failure.
				attemptedTaskIdsRef.current.delete(taskId);
				return;
			}
			if (plan.noticeMessage) {
				showAppToast(
					{ intent: "warning", icon: "warning-sign", message: plan.noticeMessage, timeout: 7000 },
					`terminal-reconnect-fresh-${taskId}`,
				);
			}
		},
		[startTaskSession],
	);

	useEffect(() => {
		const selectedTaskId = selectedCard?.card.id ?? null;
		// Reopening a task should re-evaluate from scratch: drop the prior task's guard.
		if (previousSelectedTaskIdRef.current !== selectedTaskId) {
			if (previousSelectedTaskIdRef.current) {
				attemptedTaskIdsRef.current.delete(previousSelectedTaskIdRef.current);
			}
			previousSelectedTaskIdRef.current = selectedTaskId;
		}

		if (!enabled || !selectedCard) {
			return;
		}
		const summary = sessions[selectedCard.card.id] ?? null;
		if (!shouldAutoRelaunchTerminalSession({ summary, columnId: selectedCard.column.id })) {
			// Once a session is live again, clear the guard so a future crash can retry.
			if (summary && isTerminalSessionLive(summary)) {
				attemptedTaskIdsRef.current.delete(selectedCard.card.id);
			}
			return;
		}
		if (attemptedTaskIdsRef.current.has(selectedCard.card.id) || !summary) {
			return;
		}
		attemptedTaskIdsRef.current.add(selectedCard.card.id);
		void relaunch(selectedCard, summary);
	}, [enabled, selectedCard, sessions, relaunch]);
}
