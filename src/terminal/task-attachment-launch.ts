// Launch-time step that turns a task's STAGED file attachments into an on-disk,
// `@`-mentionable set inside the task's worktree, and appends those mentions to
// the kickoff prompt.
//
// Background: the create dialog uploads non-image files BEFORE the task's
// worktree exists, so they are staged under the repo root at
// `<repoRoot>/.kanban/attachments/<taskId>/`. Once the task starts and its
// worktree is created, this relocates them into
// `<worktree>/.kanban/attachments/<taskId>/` (so they live with — and are
// cleaned up with — the worktree) and injects `@/path` mentions into the agent's
// opening turn. Only CLI agents that read `@`-mentions (currently claude) are
// eligible; everything else is a no-op that leaves both the prompt and the
// staging untouched. Home (sidebar) sessions are handled elsewhere (their files
// already sit in the repo-root cwd, mention injected at upload) and must NOT be
// routed here.

import { createLogger } from "../logging";
import { agentSupportsFileAttachments } from "./attachment-agents";
import { relocateAttachmentScope } from "./session-attachment-store";
import { appendAttachmentMentionsToPrompt } from "./task-attachment-prompt";

const log = createLogger("task-attachment-launch");

export interface MaterializeTaskAttachmentsInput {
	/** The task's kickoff prompt (from the card). */
	prompt: string;
	/** The resolved agent for this launch; gates whether mentions are injected. */
	agentId: string;
	/** Repo root — where the dialog staged the files (`writeWorkspaceAttachment`). */
	workspaceRoot: string;
	/** The task's worktree, created at start; the files' final home. */
	worktreeCwd: string;
	/** The task id — the shared scope id for both the staging and worktree dirs. */
	taskId: string;
}

/**
 * Relocate a task's staged attachments into its worktree and append their
 * `@`-mentions to the kickoff prompt. Returns the (possibly augmented) prompt.
 * Never throws: any failure degrades to the original prompt so a task start is
 * never blocked by attachment handling.
 */
export async function materializeTaskAttachmentsIntoPrompt(input: MaterializeTaskAttachmentsInput): Promise<string> {
	if (!agentSupportsFileAttachments(input.agentId)) {
		return input.prompt;
	}
	// A task worktree is always distinct from the repo root; guard anyway so a
	// same-path call can never try to move files onto themselves.
	if (input.workspaceRoot === input.worktreeCwd) {
		return input.prompt;
	}
	try {
		const relocated = await relocateAttachmentScope({
			from: { root: input.workspaceRoot, scopeId: input.taskId },
			to: { root: input.worktreeCwd, scopeId: input.taskId },
		});
		if (relocated.length === 0) {
			return input.prompt;
		}
		return appendAttachmentMentionsToPrompt(
			input.prompt,
			relocated.map((entry) => entry.path),
		);
	} catch (error) {
		log.warn("failed to materialize task attachments", { error, taskId: input.taskId });
		return input.prompt;
	}
}
