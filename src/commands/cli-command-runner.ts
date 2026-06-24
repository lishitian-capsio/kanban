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
import { renderHumanError, renderHumanSuccess } from "../cli-human-render";
import { type CliSpinner, printLine, shouldUseColor, startCliSpinner } from "../cli-output";
import {
	buildFailureEnvelope,
	buildSuccessEnvelope,
	type CliEnvelope,
	type CliWarning,
	classifyError,
	DEPRECATION_WARNING_PREFIX,
	exitCodeForErrorCode,
	resolveOutputMode,
} from "./cli-envelope";

/** Env var that silences the human-channel (stderr) deprecation note for migrated scripts (§8). */
const SUPPRESS_DEPRECATION_ENV = "KANBAN_SUPPRESS_DEPRECATION";

function isTruthyEnv(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * Surface deprecation warnings on the human channel (§3.3 rule 5 / §8): a one-line note per
 * `deprecated_*` warning on stderr, so it never pollutes the single JSON document on stdout.
 * Independent of success/failure and of output mode — the machine channel carries the same
 * warnings in `warnings[]`. Silenced by {@link SUPPRESS_DEPRECATION_ENV} for migrated scripts.
 */
function emitDeprecationNotesToStderr(warnings: CliWarning[] | undefined): void {
	if (!warnings || warnings.length === 0 || isTruthyEnv(process.env[SUPPRESS_DEPRECATION_ENV])) {
		return;
	}
	for (const warning of warnings) {
		if (warning.code.startsWith(DEPRECATION_WARNING_PREFIX)) {
			process.stderr.write(`⚠ ${warning.message}\n`);
		}
	}
}

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
	/** Machine-stable advisories surfaced in the success envelope and the human footer (dim ⚠ lines). */
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
	/**
	 * Optional progress spinner for a long-running handler (design doc §4.3). Shown only in
	 * human mode and only when not `--quiet`; renders on stderr (never stdout), so the
	 * machine channel stays a single clean JSON document. Resolves to a terminal ✓/✗.
	 */
	spinner?: {
		/** In-progress spinner text. */
		text: string;
		/** Success line (defaults to `text`). Receives the handler's result data. */
		succeedText?: (data: Record<string, unknown>) => string;
		/** Failure line (defaults to `text`). */
		failText?: string;
	};
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
		printLine(
			renderHuman ? renderHuman(envelope.data) : renderHumanSuccess(envelope.command, envelope.data, { useColor }),
		);
		// Human-channel deprecation notes are emitted to stderr by `emitDeprecationNotesToStderr`
		// (design doc §8), so the stdout result stays a single clean document; nothing to add here.
		return;
	}
	printLine(
		renderHumanError({
			command: envelope.command,
			message: envelope.error.message,
			code: envelope.error.code,
			useColor,
		}),
	);
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

	// A progress spinner is human-only (stderr) and suppressed by `--quiet`; in `--json` mode
	// it must never run, or it would risk interleaving with the single stdout document.
	const spinner: CliSpinner | null =
		options.spinner && mode === "human" && !options.globals?.quiet ? startCliSpinner(options.spinner.text) : null;

	// `options.warnings` may be a mutable array the handler pushes into while it runs (e.g. a
	// `deprecated_flag` warning is only known after the id is resolved *inside* the handler, so
	// that a missing-id `CliError` thrown during resolution still becomes a structured failure
	// envelope rather than an uncaught top-level error). The human-channel stderr note and the
	// machine-channel `warnings[]` are therefore both surfaced *after* the handler settles.
	try {
		const result = await handler();
		spinner?.succeed(options.spinner?.succeedText?.(result));
		emitDeprecationNotesToStderr(options.warnings);
		emit(
			buildSuccessEnvelope(commandId, toEnvelopeData(result), options.warnings),
			mode,
			options.globals,
			options.renderHuman,
		);
	} catch (error) {
		spinner?.fail(options.spinner?.failText);
		const classified = classifyError(error);
		emitDeprecationNotesToStderr(options.warnings);
		emit(buildFailureEnvelope(commandId, classified, options.warnings), mode, options.globals);
		process.exitCode = exitCodeForErrorCode(classified.code);
	}
}
