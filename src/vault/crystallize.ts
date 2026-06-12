import type { SessionMessage, SessionMessageRole } from "../session/session-message";

/**
 * "Crystallize" turns a chat transcript into a readable vault document. This
 * module is the pure core — selecting the span of messages and rendering them to
 * markdown — so it is unit-testable without an agent runtime. The tRPC layer
 * loads the transcript (the unified {@link SessionMessage} model, shared by pi
 * and the CLI/terminal agents) and writes the result through the vault store; the
 * raw session journal (`messages.jsonl`) is never moved into the vault.
 */

export interface SelectTranscriptOptions {
	/** Keep only the trailing N messages. Non-positive / unset = the whole thread. */
	lastN?: number;
}

export interface RenderTranscriptOptions {
	/** Use this title verbatim instead of deriving one from the conversation. */
	title?: string;
}

export interface CrystallizedTranscript {
	title: string;
	body: string;
}

// Only the human-readable conversation turns become document prose. Reasoning,
// tool I/O, status markers and system notes are transcript scaffolding, not
// content worth crystallizing.
const RENDERED_ROLES: ReadonlySet<SessionMessageRole> = new Set<SessionMessageRole>(["user", "assistant"]);

const ROLE_LABELS: Partial<Record<SessionMessageRole, string>> = {
	user: "User",
	assistant: "Assistant",
};

const MAX_TITLE_LENGTH = 80;
const DEFAULT_TITLE = "Untitled note";

/** Select the span of a transcript to crystallize: the whole thread, or the last N messages. */
export function selectTranscriptMessages(
	messages: readonly SessionMessage[],
	options: SelectTranscriptOptions,
): SessionMessage[] {
	const lastN = options.lastN;
	if (typeof lastN === "number" && lastN > 0 && lastN < messages.length) {
		return messages.slice(messages.length - lastN);
	}
	return [...messages];
}

/** Render the conversation turns of a transcript into a titled markdown document. */
export function renderTranscriptToMarkdown(
	messages: readonly SessionMessage[],
	options: RenderTranscriptOptions = {},
): CrystallizedTranscript {
	const turns = messages.filter((message) => RENDERED_ROLES.has(message.role) && message.content.trim().length > 0);

	const sections = turns.map((message) => {
		const label = ROLE_LABELS[message.role] ?? message.role;
		return `**${label}:**\n\n${message.content.trim()}`;
	});

	return {
		title: options.title?.trim() || deriveTitle(turns),
		body: sections.join("\n\n"),
	};
}

function deriveTitle(turns: readonly SessionMessage[]): string {
	const firstUser = turns.find((message) => message.role === "user");
	const firstLine = firstUser?.content
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) {
		return DEFAULT_TITLE;
	}
	return firstLine.length > MAX_TITLE_LENGTH ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : firstLine;
}
