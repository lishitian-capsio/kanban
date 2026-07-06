// CLI agents that understand `@/path` file mentions and therefore accept
// dragged/pasted NON-image file attachments (persisted to disk, then referenced
// as an `@/path` mention in the kickoff prompt). Scoped to claude this phase.
//
// This is the BACKEND twin of web-ui's `src/runtime/attachment-agents.ts` — the
// runtime can't import web-ui code, so the set is intentionally mirrored. Keep
// the two in sync; adding an agent is one entry in each plus its own mention
// formatting.
const ATTACHMENT_MENTION_AGENT_IDS = new Set<string>(["claude"]);

export function agentSupportsFileAttachments(agentId: string | null | undefined): boolean {
	return agentId != null && ATTACHMENT_MENTION_AGENT_IDS.has(agentId);
}
