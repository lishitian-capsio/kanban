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

import { printHumanResult } from "../cli-output";
import { shouldUseColor } from "../cli-output";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import {
	type CliEnvelope,
	type CliWarning,
	buildFailureEnvelope,
	buildSuccessEnvelope,
	classifyError,
	exitCodeForErrorCode,
	resolveOutputMode,
} from "./cli-envelope";

export interface RunCliCommandOptions {
	/** Machine-stable advisories surfaced in the success envelope and (TODO P4) human footer. */
	warnings?: CliWarning[];
	/** Argv to scan for `--json` / `--human` (defaults to `process.argv`). */
	argv?: string[];
}

/**
 * P0-interim flag detection. The global `--json` / `--human` options are declared once at
 * program level in phase P1 (read via `optsWithGlobals()`); until then we scan argv so the
 * flags work today without per-command plumbing.
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

function emit(envelope: CliEnvelope, mode: "json" | "human"): void {
	if (mode === "json") {
		// Exactly one JSON document on stdout — keep it pretty (matches the prior `printJson`
		// output) and `JSON.parse`-able. Never interleave anything else here.
		process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
		return;
	}
	const useColor = shouldUseColor();
	if (envelope.ok) {
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
	const mode = resolveOutputMode({
		...detectOutputModeFlags(options.argv ?? process.argv),
		envValue: process.env.KANBAN_OUTPUT,
		stdoutIsTTY: Boolean(process.stdout?.isTTY),
	});

	try {
		const result = await handler();
		emit(buildSuccessEnvelope(commandId, toEnvelopeData(result), options.warnings), mode);
	} catch (error) {
		const classified = classifyError(error);
		const legacyMirror = `${commandFamilyLabel(commandId)} command failed at ${getKanbanRuntimeOrigin()}: ${classified.message}`;
		emit(buildFailureEnvelope(commandId, classified, legacyMirror), mode);
		process.exitCode = exitCodeForErrorCode(classified.code);
	}
}
