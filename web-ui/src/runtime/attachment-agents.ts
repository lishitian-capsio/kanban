// CLI agents that understand `@/path` file mentions and therefore accept
// dragged/pasted NON-image file attachments (persisted to disk, then injected as
// an `@/path` mention). Scoped to claude this phase; adding an agent is one entry
// here plus its own mention formatting. Shared by BOTH the live terminal panel
// (agent-terminal-panel.tsx, writing into the task worktree) and the new-thread
// create dialog (home-thread-create-dialog.tsx, writing into the workspace repo
// root) so the two surfaces gate on exactly the same set.
const ATTACHMENT_MENTION_AGENT_IDS = new Set<string>(["claude"]);

export function agentSupportsFileAttachments(agentId: string | null | undefined): boolean {
	return agentId != null && ATTACHMENT_MENTION_AGENT_IDS.has(agentId);
}
