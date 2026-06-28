// Controller for command-mode voice input in the home chat.
//
// Bridges the pure `planVoiceCommand` outcome to UI side effects: chat/unrecognized
// utterances fall back to the composer draft (never auto-sent), rejections also fall
// back to the draft plus a toast hint, and a recognized board command opens a
// confirmation before anything with side effects runs. On confirm it sends an
// id-qualified instruction down the existing agent path (see voice-command.ts).

import { useCallback, useState } from "react";

import { showAppToast } from "@/components/app-toaster";

import {
	buildAgentInstruction,
	planVoiceCommand,
	type ResolvedVoiceCommand,
	type VoiceCommandBoard,
	type VoiceCommandSummary,
} from "./voice-command";

export interface PendingVoiceCommand {
	resolved: ResolvedVoiceCommand;
	summary: VoiceCommandSummary;
}

export interface UseVoiceCommandControllerInput {
	/** Current board snapshot for resolving spoken task/column references. Null = not ready. */
	board: VoiceCommandBoard | null;
	/** Send the confirmed, id-qualified instruction to the agent (e.g. chatPanel.sendText). */
	onExecute: (instruction: string) => void | Promise<void>;
	/** Fall back to filling the composer draft for chat/unrecognized/rejected utterances. */
	onFillDraft: (text: string) => void;
}

export interface UseVoiceCommandControllerResult {
	pending: PendingVoiceCommand | null;
	handleTranscript: (transcript: string) => void;
	confirm: () => void;
	cancel: () => void;
}

export function useVoiceCommandController({
	board,
	onExecute,
	onFillDraft,
}: UseVoiceCommandControllerInput): UseVoiceCommandControllerResult {
	const [pending, setPending] = useState<PendingVoiceCommand | null>(null);

	const handleTranscript = useCallback(
		(transcript: string) => {
			const text = transcript.trim();
			if (text.length === 0) {
				return;
			}
			// Without a board we can't resolve targets — degrade to the draft path.
			if (!board) {
				onFillDraft(text);
				return;
			}
			const outcome = planVoiceCommand(text, board);
			if (outcome.kind === "chat") {
				onFillDraft(outcome.text);
				return;
			}
			if (outcome.kind === "reject") {
				// Misrecognition must never auto-execute: drop into the draft to edit, and
				// say why it wasn't run.
				onFillDraft(outcome.text);
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: outcome.rejection.message,
					timeout: 5000,
				});
				return;
			}
			setPending({ resolved: outcome.resolved, summary: outcome.summary });
		},
		[board, onFillDraft],
	);

	const confirm = useCallback(() => {
		setPending((current) => {
			if (current) {
				void Promise.resolve(onExecute(buildAgentInstruction(current.resolved)));
				showAppToast({
					intent: "success",
					icon: "tick",
					message: `已发送指令:${current.summary.title}`,
					timeout: 4000,
				});
			}
			return null;
		});
	}, [onExecute]);

	const cancel = useCallback(() => {
		setPending(null);
	}, []);

	return { pending, handleTranscript, confirm, cancel };
}
