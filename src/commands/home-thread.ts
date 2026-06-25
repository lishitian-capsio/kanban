/**
 * `kanban home-thread …` — CLI surface for the home (sidebar) chat threads.
 *
 * The only verb today is `set-title`, invoked by a thread's OWN agent to give the thread
 * a concise title. The agent does not need to know its thread id: Kanban injects the
 * synthetic home session id into every agent subprocess as `KANBAN_SESSION_TASK_ID`
 * (see `hook-runtime-context.ts`), so the command resolves the workspace + thread from
 * that env by default, with an explicit `--session-id` override for scripted use.
 *
 * The title is recorded as `auto` and routed through the workspace-scoped
 * `setHomeThreadTitle` runtime endpoint, which persists it to `threads.json` and skips
 * the write when the user has pinned the title with a manual rename. Output flows through
 * the standard `runCliCommand` envelope like every other CLI command.
 */

import type { Command } from "commander";

import { parseHomeAgentSessionId } from "../core/home-agent-session";
import { KANBAN_SESSION_TASK_ID_ENV } from "../terminal/hook-runtime-context";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";
import { CliError } from "./cli-envelope";
import { createRuntimeTrpcClient, type JsonRecord } from "./runtime-workspace";

function resolveSessionId(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
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
		`home-thread set-title could not determine the thread: no --session-id was given and ${KANBAN_SESSION_TASK_ID_ENV} is not set. Run it from inside a Kanban home chat session, or pass --session-id.`,
	);
}

async function setHomeThreadTitle(input: { title: string; sessionId: string | undefined }): Promise<JsonRecord> {
	const sessionId = resolveSessionId(input.sessionId, process.env);
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
}
