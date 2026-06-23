import { isNativeAgentSelected } from "@/runtime/native-agent";
import type { RuntimeAgentId, RuntimeTaskSessionMode } from "@/runtime/types";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";

/**
 * Result shape shared by both session senders: an `ok` flag and an optional
 * human-readable failure message.
 */
export interface SessionSendResult {
	ok: boolean;
	message?: string;
}

/**
 * The two existing transports for delivering text into a live task session.
 * Native (pi) sessions go through the kanban chat channel; CLI/terminal agents
 * receive a bracketed paste followed by a submit keystroke on the PTY. Injected
 * here so the primitive stays pure and testable.
 */
export interface SessionPromptSenders {
	sendTaskChatMessage: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode },
	) => Promise<SessionSendResult>;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<SessionSendResult>;
}

export interface InjectSessionPromptInput {
	/** Target session: a task id, or a home/kanban-agent thread session id. */
	taskId: string;
	/** Arbitrary prompt text to inject into the session. */
	prompt: string;
	/**
	 * The agent backing the session, used only to pick the transport. Native
	 * (`pi`) → chat channel; anything else → terminal PTY.
	 */
	agentId: RuntimeAgentId | null;
	senders: SessionPromptSenders;
	/** Mode for native (pi) sessions. Defaults to `act`. */
	mode?: RuntimeTaskSessionMode;
	/**
	 * Delay between the paste and the submit keystroke for terminal agents. Lets
	 * the PTY process the pasted text before it is submitted. Injectable so tests
	 * don't wait on a real timer.
	 */
	submitDelayMs?: number;
}

export type InjectSessionPromptResult = SessionSendResult;

export const SESSION_PROMPT_NATIVE_FAILURE = "Could not send instructions to the task chat session.";
export const SESSION_PROMPT_TERMINAL_TYPE_FAILURE = "Could not send instructions to the task session.";
export const SESSION_PROMPT_TERMINAL_SUBMIT_FAILURE = "Could not submit instructions to the task session.";

const DEFAULT_PASTE_SUBMIT_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

/**
 * Inject an arbitrary prompt into a live session, dispatching to the correct
 * transport for the backing agent. This is the shared primitive behind the
 * review Commit/Open-PR actions — it owns the native-vs-CLI delivery
 * choreography so callers only supply text + a target.
 *
 * It deliberately reuses the existing `sendTaskChatMessage` /
 * `sendTaskSessionInput` senders rather than reimplementing delivery.
 */
export async function injectSessionPrompt(input: InjectSessionPromptInput): Promise<InjectSessionPromptResult> {
	const { taskId, prompt, agentId, senders } = input;

	if (isNativeAgentSelected(agentId)) {
		const sent = await senders.sendTaskChatMessage(taskId, prompt, { mode: input.mode ?? "act" });
		if (!sent.ok) {
			return { ok: false, message: sent.message ?? SESSION_PROMPT_NATIVE_FAILURE };
		}
		return { ok: true };
	}

	// CLI/terminal agents: paste the (possibly multi-line) text without a
	// trailing newline so embedded newlines don't prematurely submit, then send a
	// carriage return to submit after the PTY has had a moment to ingest it.
	const typed = await senders.sendTaskSessionInput(taskId, prompt, { appendNewline: false, mode: "paste" });
	if (!typed.ok) {
		return { ok: false, message: typed.message ?? SESSION_PROMPT_TERMINAL_TYPE_FAILURE };
	}
	await delay(input.submitDelayMs ?? DEFAULT_PASTE_SUBMIT_DELAY_MS);
	const submitted = await senders.sendTaskSessionInput(taskId, "\r", { appendNewline: false });
	if (!submitted.ok) {
		return { ok: false, message: submitted.message ?? SESSION_PROMPT_TERMINAL_SUBMIT_FAILURE };
	}
	return { ok: true };
}
