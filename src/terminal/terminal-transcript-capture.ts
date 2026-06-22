// Lightweight, agent-agnostic transcript capture for CLI/terminal agent sessions.
//
// CLI agents (claude code, codex, ...) run inside a PTY and only ever produced a
// raw scrollback mirror — no structured transcript. This module folds that PTY
// activity into the shared `SessionMessage` model so terminal sessions expose the
// same per-turn message history as pi.
//
// Fidelity is intentionally "good enough" rather than exact: we do not parse every
// tool call out of the TUI. Instead we lean on two stable signals:
//   - user input (the initial prompt + keystrokes committed on Enter) → `user`
//   - the terminal scrollback that has scrolled *above* the live viewport, captured
//     at each turn boundary → `assistant`
// The volatile viewport (the live input box, spinners) is deliberately excluded by
// the caller, which only hands us the committed scrollback lines.

import { cloneSessionMessage, createSessionMessage, type SessionMessage } from "../session/session-message";
import {
	clearActiveTurnState,
	createSessionMessageBuffer,
	type SessionMessageBuffer,
} from "../session/session-message-buffer";
import { stripAnsi } from "./output-utils";

// Guard against an input line growing without bound when the agent never submits.
const MAX_PENDING_INPUT_CHARS = 8_192;

export class TerminalTranscriptCapture {
	private readonly buffer: SessionMessageBuffer = createSessionMessageBuffer();
	// Decoded, ANSI-stripped keystrokes awaiting an Enter submission.
	private pendingInput = "";
	// Lines of the most recent user message, used to drop the prompt echo that the
	// agent prints back into its scrollback at the start of the next turn.
	private lastUserMessageLines: Set<string> = new Set();

	constructor(private readonly taskId: string) {}

	/** Record a known user prompt (the initial task prompt) as a `user` message. */
	recordUserPrompt(text: string): SessionMessage | null {
		const normalized = text.trim();
		if (!normalized) {
			return null;
		}
		return this.pushUserMessage(normalized);
	}

	/**
	 * Feed raw PTY input bytes (decoded to text). Returns any `user` messages
	 * completed by an Enter keypress in this chunk.
	 */
	recordInput(chunk: string): SessionMessage[] {
		this.pendingInput = applyBackspaces(stripAnsi(this.pendingInput + chunk));
		const segments = this.pendingInput.split(/\r\n|\r|\n/);
		// The trailing segment has no terminating newline yet, so keep it pending.
		this.pendingInput = segments.pop() ?? "";
		if (this.pendingInput.length > MAX_PENDING_INPUT_CHARS) {
			this.pendingInput = this.pendingInput.slice(-MAX_PENDING_INPUT_CHARS);
		}
		const messages: SessionMessage[] = [];
		for (const segment of segments) {
			const normalized = segment.trim();
			if (normalized) {
				messages.push(this.pushUserMessage(normalized));
			}
		}
		return messages;
	}

	/**
	 * Capture the assistant turn from the terminal's committed scrollback. The mirror
	 * owns the scrolled-off cursor and hands us only the freshly committed (delta)
	 * lines, which we emit as a single `assistant` message. Returns null when the
	 * delta is empty after trimming blank edges and the echoed prompt.
	 */
	captureCommittedLines(committedLines: string[]): SessionMessage | null {
		const trimmed = dropEchoedPrompt(trimBlankEdges(committedLines), this.lastUserMessageLines);
		if (trimmed.length === 0) {
			return null;
		}
		const message = createSessionMessage(this.taskId, "assistant", trimmed.join("\n"));
		this.buffer.messages.push(message);
		return cloneSessionMessage(message);
	}

	/** Snapshot of the captured transcript. */
	listMessages(): SessionMessage[] {
		return this.buffer.messages.map((message) => cloneSessionMessage(message));
	}

	/**
	 * Drop any half-typed input without discarding captured messages. Used when the
	 * PTY/mirror restarts: the fresh mirror starts with an empty scrollback cursor of
	 * its own, so the transcript only needs to forget the in-progress keystroke line.
	 */
	resetTurnBaseline(): void {
		this.pendingInput = "";
	}

	/** Drop all captured messages and reset every cursor. */
	reset(): void {
		this.buffer.messages = [];
		this.pendingInput = "";
		this.lastUserMessageLines = new Set();
		clearActiveTurnState(this.buffer);
	}

	private pushUserMessage(content: string): SessionMessage {
		const message = createSessionMessage(this.taskId, "user", content);
		this.buffer.messages.push(message);
		this.lastUserMessageLines = new Set(
			content
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0),
		);
		return cloneSessionMessage(message);
	}
}

function applyBackspaces(input: string): string {
	let output = "";
	for (const char of input) {
		if (char === "\b" || char === "\u007f") {
			output = output.slice(0, -1);
			continue;
		}
		output += char;
	}
	return output;
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim().length === 0) {
		start += 1;
	}
	while (end > start && lines[end - 1].trim().length === 0) {
		end -= 1;
	}
	return lines.slice(start, end);
}

function dropEchoedPrompt(lines: string[], echoedLines: Set<string>): string[] {
	if (echoedLines.size === 0) {
		return lines;
	}
	let start = 0;
	while (start < lines.length && echoedLines.has(lines[start].trim())) {
		start += 1;
	}
	return trimBlankEdges(lines.slice(start));
}
