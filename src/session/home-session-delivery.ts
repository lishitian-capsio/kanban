import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveHomeAgentId } from "../core/home-agent-session";

/**
 * The pi-side delivery primitive: enqueue a user message and run. Structural
 * subset of `PiTaskSessionService` so the seam stays testable with fakes.
 */
export interface PiHomeDeliveryPort {
	hasActiveAgentSession(taskId: string): boolean;
	sendTaskSessionInput(taskId: string, text: string): Promise<RuntimeTaskSessionSummary | null>;
}

/**
 * The terminal-side delivery primitive: write into the live PTY (Enter committed
 * via a trailing CR). Structural subset of `TerminalSessionManager`.
 */
export interface TerminalHomeDeliveryPort {
	isSessionLive(taskId: string): boolean;
	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null;
}

export interface HomeSessionDeliveryDeps {
	piService: PiHomeDeliveryPort;
	terminalManager: TerminalHomeDeliveryPort;
	/**
	 * (Re)launch the home session with `prompt` as its kickoff turn, used when the
	 * session is not live: pi was disposed, or a CLI process exited (the launch path
	 * resumes claude via the recorded `--session-id`/`--resume`). Agent-agnostic —
	 * it routes by the session id's encoded agent, same as a normal session start.
	 */
	launch: (sessionId: string, prompt: string) => Promise<void>;
}

/**
 * Unified seam: deliver a prompt to a home agent session and trigger execution,
 * routed to the agent that backs the session (decision 43f28). pi → enqueue user
 * message + run; CLI/terminal → `writeInput` + Enter. When the session is not live
 * it (re)launches with the prompt as the kickoff, absorbing CLI liveness/resume.
 *
 * Behavior is agent-neutral (plain-text prompt + existing verbs); heterogeneity is
 * isolated to the routing here and the resume in `launch`.
 */
export async function deliverPromptToHomeSession(
	deps: HomeSessionDeliveryDeps,
	sessionId: string,
	prompt: string,
): Promise<void> {
	const agentId = resolveHomeAgentId(sessionId);
	if (agentId === "pi") {
		if (deps.piService.hasActiveAgentSession(sessionId)) {
			await deps.piService.sendTaskSessionInput(sessionId, prompt);
			return;
		}
		await deps.launch(sessionId, prompt);
		return;
	}
	// CLI/terminal agents (claude/codex/...): write into the live PTY, else relaunch.
	if (deps.terminalManager.isSessionLive(sessionId)) {
		deps.terminalManager.writeInput(sessionId, Buffer.from(`${prompt}\r`, "utf8"));
		return;
	}
	await deps.launch(sessionId, prompt);
}
