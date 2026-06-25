/**
 * `kanban home-thread …` — CLI surface for the home (sidebar) chat threads.
 *
 * Two verbs, both invoked by a thread's OWN agent and both resolving the thread from the
 * session env rather than an explicit id. The agent does not need to know its thread id:
 * Kanban injects the synthetic home session id into every agent subprocess as
 * `KANBAN_SESSION_TASK_ID` (see `hook-runtime-context.ts`), so the commands resolve the
 * workspace + thread from that env by default, with an explicit `--session-id` override
 * for scripted use.
 *
 * - `set-title` records a concise title (as `auto`) via the workspace-scoped
 *   `setHomeThreadTitle` endpoint, which persists it to `threads.json` and skips the write
 *   when the user has pinned the title with a manual rename.
 * - `suggest-next` records a transient `pendingNextStep` suggestion via
 *   `setHomeThreadNextStep` — a ready-to-send next user message the sidebar surfaces as a
 *   clickable chip; the runtime clears it when the user next sends a message in the thread.
 *
 * Output flows through the standard `runCliCommand` envelope like every other CLI command.
 */

import type { Command } from "commander";

import { parseHomeAgentSessionId } from "../core/home-agent-session";
import { KANBAN_SESSION_TASK_ID_ENV } from "../terminal/hook-runtime-context";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";
import { CliError } from "./cli-envelope";
import { createRuntimeTrpcClient, type JsonRecord } from "./runtime-workspace";

function resolveSessionId(verb: string, explicit: string | undefined, env: NodeJS.ProcessEnv): string {
	const fromFlag = explicit?.trim();
	if (fromFlag) {
		return fromFlag;
	}
	const fromEnv = env[KANBAN_SESSION_TASK_ID_ENV]?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	throw new CliError(
		"invalid_argument",
		`home-thread ${verb} could not determine the thread: no --session-id was given and ${KANBAN_SESSION_TASK_ID_ENV} is not set. Run it from inside a Kanban home chat session, or pass --session-id.`,
	);
}

async function setHomeThreadTitle(input: { title: string; sessionId: string | undefined }): Promise<JsonRecord> {
	const sessionId = resolveSessionId("set-title", input.sessionId, process.env);
	const parsed = parseHomeAgentSessionId(sessionId);
	if (!parsed) {
		throw new CliError(
			"invalid_argument",
			`"${sessionId}" is not a Kanban home chat session id, so it has no thread to title.`,
		);
	}

	// The session id's workspace segment IS the runtime workspace id (that is how the
	// synthetic id is minted), so it can drive the tRPC workspace header directly without
	// a disk lookup.
	const runtimeClient = createRuntimeTrpcClient(parsed.workspaceId);
	const response = await runtimeClient.runtime.setHomeThreadTitle.mutate({
		id: parsed.threadId,
		title: input.title,
	});
	if (!response.ok) {
		throw new Error(response.error ?? "Could not set the home chat thread title.");
	}

	const thread = response.thread;
	// `thread === null` is the benign default-thread no-op; a returned `manual` title means
	// the user pinned it and the agent's title was intentionally not applied.
	const pinned = thread?.titleSource === "manual";
	return {
		ok: true,
		threadId: parsed.threadId,
		title: thread?.name ?? input.title,
		titleSource: thread?.titleSource ?? null,
		applied: thread !== null && !pinned,
		pinned,
	};
}

async function suggestHomeThreadNextStep(input: {
	suggestion: string;
	sessionId: string | undefined;
}): Promise<JsonRecord> {
	const sessionId = resolveSessionId("suggest-next", input.sessionId, process.env);
	const parsed = parseHomeAgentSessionId(sessionId);
	if (!parsed) {
		throw new CliError(
			"invalid_argument",
			`"${sessionId}" is not a Kanban home chat session id, so it has no thread to suggest a next step for.`,
		);
	}

	const runtimeClient = createRuntimeTrpcClient(parsed.workspaceId);
	const response = await runtimeClient.runtime.setHomeThreadNextStep.mutate({
		id: parsed.threadId,
		suggestion: input.suggestion,
	});
	if (!response.ok) {
		throw new Error(response.error ?? "Could not set the home chat thread next-step suggestion.");
	}

	const thread = response.thread;
	// `thread === null` is the benign default-thread no-op (the default thread carries no
	// suggestion); a non-null thread echoes back the recorded suggestion.
	return {
		ok: true,
		threadId: parsed.threadId,
		suggestion: thread?.pendingNextStep ?? input.suggestion,
		applied: thread !== null,
	};
}

export function registerHomeThreadCommand(program: Command): void {
	const homeThread = program
		.command("home-thread")
		.description("Manage the home (sidebar) chat threads from the CLI.");

	homeThread
		.command("set-title")
		.description("Set the calling thread's title (agent self-titling). Resolves the thread from the session env.")
		.argument("<title>", "Concise title for the thread (e.g. a 3-6 word summary).")
		.option(
			"--session-id <id>",
			`Home chat session id to title. Defaults to ${KANBAN_SESSION_TASK_ID_ENV} from the agent session.`,
		)
		.action(async function (this: Command, title: string, options: { sessionId?: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"home-thread.set-title",
				async () => await setHomeThreadTitle({ title, sessionId: options.sessionId }),
				{ globals },
			);
		});

	homeThread
		.command("suggest-next")
		.description(
			"Suggest the calling thread's next step (agent-driven). Surfaced in the sidebar as a clickable chip that sends the text as the next message. Resolves the thread from the session env.",
		)
		.argument("<suggestion>", "A concise, ready-to-send next-step prompt phrased as the user's next message.")
		.option(
			"--session-id <id>",
			`Home chat session id to suggest for. Defaults to ${KANBAN_SESSION_TASK_ID_ENV} from the agent session.`,
		)
		.action(async function (this: Command, suggestion: string, options: { sessionId?: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"home-thread.suggest-next",
				async () => await suggestHomeThreadNextStep({ suggestion, sessionId: options.sessionId }),
				{ globals },
			);
		});
}
