/**
 * Shared execution wrapper for CLI command handlers (design doc §4, phase P0).
 *
 * A handler computes a plain result object; this runner renders it through one of two
 * channels chosen per {@link resolveOutputMode}:
 *   - machine (`--json` / piped): a single `JSON.parse`-able envelope on stdout, nothing
 *     else (diagnostics belong on stderr via the logger — never stdout in this mode);
 *   - human (TTY default): the readable summary from `cli-output.ts`.
 *
 * It replaces the four divergent `run{Task,Db,File,Vault}Command` wrappers, each of which
 * previously hand-rolled a free-text `{ ok:false, error:"<Family> command failed at …" }`
 * payload with a blanket `exitCode = 1`.
 */

import type { Command } from "commander";
import { printHumanResult, printLine, shouldUseColor } from "../cli-output";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import {
	buildFailureEnvelope,
	buildSuccessEnvelope,
	type CliEnvelope,
	type CliWarning,
	classifyError,
	exitCodeForErrorCode,
	resolveOutputMode,
} from "./cli-envelope";

/**
 * The program-level global flags (design doc §6.1), resolved for a single subcommand
 * invocation. Declared once on the root program and inherited by every subcommand; an
 * action reads them via {@link readGlobalCliOptions} rather than re-declaring per command.
 */
export interface GlobalCliOptions {
	/** `--project-path <path>` — workspace to operate on (undefined ⇒ cwd workspace). */
	projectPath?: string;
	/** `--json` — force machine output. */
	json: boolean;
	/** `--human` — force human output even when piped. */
	human: boolean;
	/** `--color` / `--no-color` (commander stores `--no-color` as `color === false`). */
	color: boolean;
	/** `--quiet` — suppress the human summary footer / spinners (no effect on `--json`). */
	quiet: boolean;
}

/**
 * Read the program-level global flags merged onto a subcommand via commander's
 * `optsWithGlobals()`.
 *
 * MUST be called from an action declared as a regular `function` (so `this` is the
 * Command), not an arrow. This is the documented commander gotcha (AGENTS.md): a value
 * passed *after* the subcommand (`kanban task list --project-path X`) routes to the
 * declaring ancestor, so the action's own `options` arg would miss it — only the merged
 * `optsWithGlobals()` view sees it regardless of position.
 */
export function readGlobalCliOptions(command: Command): GlobalCliOptions {
	const merged = command.optsWithGlobals() as {
		projectPath?: unknown;
		json?: unknown;
		human?: unknown;
		color?: unknown;
		quiet?: unknown;
	};
	return {
		projectPath: typeof merged.projectPath === "string" ? merged.projectPath : undefined,
		json: merged.json === true,
		human: merged.human === true,
		// commander defaults `--no-color`'s `color` to `true`; only an explicit `--no-color` flips it.
		color: merged.color !== false,
		quiet: merged.quiet === true,
	};
}

export interface RunCliCommandOptions {
	/** Machine-stable advisories surfaced in the success envelope and (TODO P5) human footer. */
	warnings?: CliWarning[];
	/** Resolved program-level global flags (§6.1) from {@link readGlobalCliOptions}. */
	globals?: GlobalCliOptions;
	/** Argv to scan for `--json` / `--human` when {@link globals} is absent (defaults to `process.argv`). */
	argv?: string[];
	/**
	 * Optional custom human renderer for the success `data`. When provided, it replaces the
	 * generic key/value summary in human mode (e.g. `remote status`'s compact panel); `--json`
	 * output is unaffected so the two channels still share the one result object.
	 */
	renderHuman?: (data: Record<string, unknown>) => string;
}

/**
 * Fallback flag detection for callers that do not pass resolved {@link GlobalCliOptions}
 * (e.g. unit tests, or any seam not yet plumbed through `optsWithGlobals()`). When globals
 * are available they take precedence — see {@link runCliCommand}.
 */
export function detectOutputModeFlags(argv: string[]): { jsonFlag: boolean; humanFlag: boolean } {
	return {
		jsonFlag: argv.includes("--json"),
		humanFlag: argv.includes("--human"),
	};
}

/**
 * Absorb a handler's top-level `ok:true` (the legacy success marker) into the envelope so
 * it is not duplicated inside `data`. Nested `ok` fields (e.g. auto-started task records)
 * are part of the data and are preserved.
 */
function toEnvelopeData(result: Record<string, unknown>): Record<string, unknown> {
	if (!("ok" in result)) {
		return result;
	}
	const { ok: _ok, ...rest } = result;
	return rest;
}

/** Human-readable family label for the legacy `error` string mirror (matches the old prefix). */
function commandFamilyLabel(commandId: string): string {
	const family = commandId.split(".")[0] ?? commandId;
	switch (family) {
		case "task":
			return "Task";
		case "db":
			return "Database";
		case "file":
			return "File";
		case "vault":
			return "Vault";
		default:
			return family.charAt(0).toUpperCase() + family.slice(1);
	}
}

function emit(
	envelope: CliEnvelope,
	mode: "json" | "human",
	globals?: GlobalCliOptions,
	renderHuman?: (data: Record<string, unknown>) => string,
): void {
	if (mode === "json") {
		// Exactly one JSON document on stdout — keep it pretty (matches the prior `printJson`
		// output) and `JSON.parse`-able. Never interleave anything else here.
		process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
		return;
	}
	// `--no-color` (globals.color === false) forces color off; otherwise fall back to
	// TTY/NO_COLOR detection in `shouldUseColor`.
	const useColor = shouldUseColor(globals ? globals.color === false : false);
	if (envelope.ok) {
		if (renderHuman) {
			printLine(renderHuman(envelope.data));
			return;
		}
		printHumanResult({ ok: true, command: envelope.command, data: envelope.data, useColor });
		return;
	}
	printHumanResult({
		ok: false,
		command: envelope.command,
		errorMessage: envelope.error.message,
		errorCode: envelope.error.code,
		useColor,
	});
}

export async function runCliCommand(
	commandId: string,
	handler: () => Promise<Record<string, unknown>>,
	options: RunCliCommandOptions = {},
): Promise<void> {
	// Resolved global flags (§6.1) take precedence; fall back to scanning argv for callers
	// not yet plumbed through `optsWithGlobals()` (e.g. unit tests).
	const argvFlags = detectOutputModeFlags(options.argv ?? process.argv);
	const mode = resolveOutputMode({
		jsonFlag: options.globals?.json ?? argvFlags.jsonFlag,
		humanFlag: options.globals?.human ?? argvFlags.humanFlag,
		envValue: process.env.KANBAN_OUTPUT,
		stdoutIsTTY: Boolean(process.stdout?.isTTY),
	});

	try {
		const result = await handler();
		emit(
			buildSuccessEnvelope(commandId, toEnvelopeData(result), options.warnings),
			mode,
			options.globals,
			options.renderHuman,
		);
	} catch (error) {
		const classified = classifyError(error);
		const legacyMirror = `${commandFamilyLabel(commandId)} command failed at ${getKanbanRuntimeOrigin()}: ${classified.message}`;
		emit(buildFailureEnvelope(commandId, classified, legacyMirror), mode, options.globals);
		process.exitCode = exitCodeForErrorCode(classified.code);
	}
}
