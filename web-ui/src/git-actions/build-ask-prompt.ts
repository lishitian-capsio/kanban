// Pure prompt builders for the review "Ask" action. The Ask action injects one
// of these prompts into a live session via the shared `injectSessionPrompt`
// primitive — it never moves the task to done, unlike Commit/Open PR. Two
// destinations route the agent's review question to whoever should answer it.

/** Where the review question is routed. */
export type AskTarget = "self" | "kanban";

export interface AskSelfPromptInput {
	/** The question the task agent raised at review (may be null/empty). */
	question: string | null;
	/** Human-readable task title, for context. */
	taskTitle: string;
}

export interface AskKanbanPromptInput {
	question: string | null;
	taskId: string;
	taskTitle: string;
	/** The task's original prompt/spec, for the kanban agent's context. */
	taskPrompt: string;
	/** The task worktree path, when known. */
	workspacePath?: string | null;
}

/** Render multi-line text as a markdown blockquote so it reads as a quotation. */
function blockquote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

/**
 * "问自己" — return the question to the task agent's own session and ask it to
 * make a judgment call and continue, rather than parking in review.
 */
export function buildAskSelfPrompt({ question, taskTitle }: AskSelfPromptInput): string {
	const lines: string[] = [];
	if (question && question.trim().length > 0) {
		lines.push("During review you raised this question:");
		lines.push("");
		lines.push(blockquote(question.trim()));
		lines.push("");
		lines.push(
			"Please make your own best judgment and continue the task. If you can resolve this " +
				"yourself, do so and proceed. Only stop again if you genuinely cannot move forward " +
				"without input — and if so, state precisely what you need.",
		);
	} else {
		lines.push(
			`Please re-review your work on "${taskTitle}", make your own best judgment, and ` +
				"continue the task if you can.",
		);
	}
	return lines.join("\n");
}

/**
 * "问 kanban agent" — hand the question plus task context to the coordinating
 * kanban agent. The prompt embeds the loop guardrail intent (bounded attempts,
 * escalate to a human) so the kanban agent does not auto-bounce indefinitely.
 */
export function buildAskKanbanAgentPrompt({
	question,
	taskId,
	taskTitle,
	taskPrompt,
	workspacePath,
}: AskKanbanPromptInput): string {
	const lines: string[] = [
		"A task you are coordinating is waiting in review and needs a decision.",
		"",
		`Task: ${taskTitle} (${taskId})`,
	];
	if (workspacePath && workspacePath.trim().length > 0) {
		lines.push(`Worktree: ${workspacePath.trim()}`);
	}
	const trimmedPrompt = taskPrompt.trim();
	if (trimmedPrompt.length > 0) {
		lines.push("", "Original task prompt:", blockquote(trimmedPrompt));
	}
	if (question && question.trim().length > 0) {
		lines.push("", "The task agent asked:", blockquote(question.trim()));
	} else {
		lines.push("", "The task agent stopped for review without a specific question.");
	}
	lines.push(
		"",
		"Decide how to resolve this: answer the question and relay guidance back to the task, " +
			"adjust the task, or escalate to a human if you are unsure. Do not loop indefinitely — " +
			"if you cannot make progress after a few attempts, hand it to a human.",
	);
	return lines.join("\n");
}
