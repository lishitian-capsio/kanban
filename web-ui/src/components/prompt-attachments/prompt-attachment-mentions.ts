// Pure helpers for injecting/removing an `@/path` file-mention into a prompt
// string. Shared by composers that inject mentions at upload time (the new-thread
// create dialog). Kept side-effect-free so it is trivially unit-testable.

/** Append a mention to the prompt, keeping a single separating space. */
export function appendMentionToPrompt(prompt: string, mention: string): string {
	if (prompt.length === 0 || /\s$/.test(prompt)) {
		return `${prompt}${mention}`;
	}
	return `${prompt} ${mention}`;
}

/**
 * Remove the first occurrence of an injected mention from the prompt. Falls back
 * to the space-trimmed form in case the user edited the trailing space away.
 */
export function removeMentionFromPrompt(prompt: string, mention: string): string {
	const index = prompt.indexOf(mention);
	if (index >= 0) {
		return `${prompt.slice(0, index)}${prompt.slice(index + mention.length)}`;
	}
	const trimmed = mention.trimEnd();
	const trimmedIndex = trimmed.length > 0 ? prompt.indexOf(trimmed) : -1;
	if (trimmedIndex >= 0) {
		return `${prompt.slice(0, trimmedIndex)}${prompt.slice(trimmedIndex + trimmed.length)}`;
	}
	return prompt;
}
