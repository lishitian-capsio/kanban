// Orchestrates the review "Ask" action: route a task agent's review question to
// whoever should answer it, without ever moving the task to done.
//
// Two destinations, both delivered through the shared `injectSessionPrompt`
// primitive (the same native-vs-CLI choreography Commit/Open PR use):
//   - "self"   → re-pose the question to the task's own session so the agent
//                makes its own call and continues.
//   - "kanban" → hand the question + task context to the coordinating kanban
//                agent. The originating-thread reverse association (Ask-B) lives
//                on the backend and is being added in parallel; until it lands we
//                fall back to a fresh kanban-agent thread bound to this task (see
//                `resolveKanbanAskThread`). The "ask kanban" route is bounded by
//                `ask-guardrail` so it cannot form an unbounded automatic loop.
//
// Critically, neither route touches the board column — unlike the Commit/Open PR
// path (which can transition a zero-diff task to done), Ask leaves the task in
// review.

import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import { useCallback, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { evaluateKanbanAsk, recordKanbanAsk } from "@/git-actions/ask-guardrail";
import { type AskTarget, buildAskKanbanAgentPrompt, buildAskSelfPrompt } from "@/git-actions/build-ask-prompt";
import { injectSessionPrompt, type SessionPromptSenders } from "@/git-actions/inject-session-prompt";
import { resolveTaskReviewQuestion } from "@/git-actions/resolve-review-question";
import type { HomeThread } from "@/hooks/use-home-threads";
import { resolveEffectiveTaskAgentId } from "@/runtime/native-agent";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import type { BoardData } from "@/types";
import { createLogger } from "@/utils/logger";

const log = createLogger("ask-action");

/** The coordinating kanban agent is the native (main) agent. */
const KANBAN_MAIN_AGENT_ID: RuntimeAgentId = "pi";

const ASK_FAILURE_FALLBACK = "Could not send the question to the session.";

export interface UseAskActionInput {
	currentProjectId: string | null;
	board: BoardData;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	sendTaskChatMessage: SessionPromptSenders["sendTaskChatMessage"];
	sendTaskSessionInput: SessionPromptSenders["sendTaskSessionInput"];
	/** Create a new home chat thread; returns the created thread (or null on failure). */
	createHomeThread: (input: { name: string; agentId: RuntimeAgentId }) => Promise<HomeThread | null>;
}

export interface UseAskActionResult {
	askTaskLoadingById: Record<string, boolean>;
	handleAskSelf: (taskId: string) => void;
	handleAskKanbanAgent: (taskId: string) => void;
}

export function useAskAction({
	currentProjectId,
	board,
	taskSessions,
	runtimeProjectConfig,
	sendTaskChatMessage,
	sendTaskSessionInput,
	createHomeThread,
}: UseAskActionInput): UseAskActionResult {
	const [askTaskLoadingById, setAskTaskLoadingById] = useState<Record<string, boolean>>({});
	// Per-task kanban thread bound during this app session, so repeated "ask
	// kanban" routes for the same task reuse one thread instead of spawning a new
	// one each time. Keyed by taskId.
	const kanbanThreadByTaskIdRef = useRef<Map<string, HomeThread>>(new Map());

	const setLoading = useCallback((taskId: string, loading: boolean) => {
		setAskTaskLoadingById((current) => {
			if ((current[taskId] ?? false) === loading) {
				return current;
			}
			return { ...current, [taskId]: loading };
		});
	}, []);

	const senders = useMemo<SessionPromptSenders>(
		() => ({ sendTaskChatMessage, sendTaskSessionInput }),
		[sendTaskChatMessage, sendTaskSessionInput],
	);

	const handleAskSelf = useCallback(
		(taskId: string) => {
			void (async () => {
				const selection = findCardSelection(board, taskId);
				if (!selection) {
					return;
				}
				const { card } = selection;
				const summary = taskSessions[taskId];
				const question = resolveTaskReviewQuestion(summary);
				const effectiveAgentId = resolveEffectiveTaskAgentId({
					sessionAgentId: summary?.agentId,
					cardAgentId: card.agentId,
					selectedAgentId: runtimeProjectConfig?.selectedAgentId ?? null,
				});
				const errorToastKey = `task-ask:${taskId}:self`;
				setLoading(taskId, true);
				try {
					const delivered = await injectSessionPrompt({
						taskId,
						prompt: buildAskSelfPrompt({ question, taskTitle: card.title }),
						agentId: effectiveAgentId,
						senders,
					});
					if (!delivered.ok) {
						showAppToast(
							{
								intent: "danger",
								icon: "warning-sign",
								message: delivered.message ?? ASK_FAILURE_FALLBACK,
								timeout: 7000,
							},
							errorToastKey,
						);
					}
				} finally {
					setLoading(taskId, false);
				}
			})();
		},
		[board, runtimeProjectConfig?.selectedAgentId, senders, setLoading, taskSessions],
	);

	const resolveKanbanAskThread = useCallback(
		async (taskId: string, taskTitle: string): Promise<HomeThread | null> => {
			// Seam: when the Ask-B reverse association (task → originating kanban
			// thread) lands on the backend, resolve and prefer that thread here.
			// Until then there is no stored origin, so always fall back to a fresh
			// kanban-agent thread bound to this task (reused across asks).
			const existing = kanbanThreadByTaskIdRef.current.get(taskId);
			if (existing) {
				return existing;
			}
			const created = await createHomeThread({
				name: `Ask: ${taskTitle}`.slice(0, 60),
				agentId: KANBAN_MAIN_AGENT_ID,
			});
			if (created) {
				kanbanThreadByTaskIdRef.current.set(taskId, created);
			}
			return created;
		},
		[createHomeThread],
	);

	const handleAskKanbanAgent = useCallback(
		(taskId: string) => {
			void (async () => {
				const selection = findCardSelection(board, taskId);
				if (!selection || !currentProjectId) {
					return;
				}
				const { card } = selection;
				const errorToastKey = `task-ask:${taskId}:kanban`;

				const guardrail = evaluateKanbanAsk(taskId);
				if (!guardrail.allowed) {
					showAppToast(
						{
							intent: "warning",
							icon: "warning-sign",
							message: guardrail.reason ?? ASK_FAILURE_FALLBACK,
							timeout: 7000,
						},
						errorToastKey,
					);
					return;
				}

				const summary = taskSessions[taskId];
				const question = resolveTaskReviewQuestion(summary);
				setLoading(taskId, true);
				try {
					const thread = await resolveKanbanAskThread(taskId, card.title);
					if (!thread) {
						showAppToast(
							{
								intent: "danger",
								icon: "warning-sign",
								message: "Could not open a kanban agent thread for this task.",
								timeout: 7000,
							},
							errorToastKey,
						);
						return;
					}
					const homeSessionId = createHomeAgentSessionId(currentProjectId, thread.agentId, thread.id);
					const delivered = await injectSessionPrompt({
						taskId: homeSessionId,
						prompt: buildAskKanbanAgentPrompt({
							question,
							taskId,
							taskTitle: card.title,
							taskPrompt: card.prompt,
							workspacePath: summary?.workspacePath ?? null,
						}),
						agentId: thread.agentId,
						senders,
					});
					if (!delivered.ok) {
						showAppToast(
							{
								intent: "danger",
								icon: "warning-sign",
								message: delivered.message ?? ASK_FAILURE_FALLBACK,
								timeout: 7000,
							},
							errorToastKey,
						);
						return;
					}
					recordKanbanAsk(taskId);
					log.info("routed review question to kanban agent", { taskId, threadId: thread.id });
					showAppToast(
						{ intent: "success", message: "Sent to the kanban agent.", timeout: 4000 },
						`task-ask-ok:${taskId}`,
					);
				} finally {
					setLoading(taskId, false);
				}
			})();
		},
		[board, currentProjectId, resolveKanbanAskThread, senders, setLoading, taskSessions],
	);

	return { askTaskLoadingById, handleAskSelf, handleAskKanbanAgent };
}

export type { AskTarget };
