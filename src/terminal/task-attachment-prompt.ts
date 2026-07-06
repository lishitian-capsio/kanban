// Kickoff-prompt injection for task-create file attachments (CLI agents that
// read `@/path` mentions, currently claude). Non-image files dropped/pasted into
// the create dialog are staged before the task's worktree exists, relocated into
// `<worktree>/.kanban/attachments/<taskId>/` at start, and then referenced from
// the agent's opening turn by appending `@`-mentions here — the file equivalent
// of `task-image-prompt.ts` (images ride as base64 → temp path; files ride as
// staged bytes → worktree `@path`). This module is pure and unit-tested.

/**
 * Format one absolute path as an `@`-mention, quoting paths that contain spaces
 * so the mention stays a single token. Mirrors the web-ui composer's
 * `buildMentionInsertText` so injected and typed mentions look identical.
 */
function buildAttachmentMention(absolutePath: string): string {
	const normalized = absolutePath.startsWith("/") ? absolutePath : `/${absolutePath}`;
	return normalized.includes(" ") ? `@"${normalized}"` : `@${normalized}`;
}

/**
 * Append an "Attached files:" line of `@`-mentions to a kickoff prompt. Blank
 * paths are dropped; an empty path list returns the prompt unchanged. When the
 * prompt itself is empty the section is returned on its own (no leading blank
 * line).
 */
export function appendAttachmentMentionsToPrompt(prompt: string, attachmentPaths: string[]): string {
	const paths = attachmentPaths.filter((path) => path.trim().length > 0);
	if (paths.length === 0) {
		return prompt;
	}
	const section = `Attached files: ${paths.map(buildAttachmentMention).join(" ")}`;
	const trimmed = prompt.trim();
	return trimmed.length > 0 ? `${trimmed}\n\n${section}` : section;
}
