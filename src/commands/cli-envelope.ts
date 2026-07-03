/**
 * The Kanban CLI machine-output contract (design doc §4 / §6.2 / §6.3, phase P0).
 *
 * Every command computes a plain result object and then renders it through one of
 * two channels — a human renderer (see `cli-output.ts`) or this machine envelope.
 * Keeping the envelope shape, the closed `error.code` enum, and the deterministic
 * `code → exit code` mapping in one pure, side-effect-free module is what lets the
 * runner (`cli-command-runner.ts`) and the unit tests share a single source of truth.
 *
 * This module performs NO I/O: no stdout writes, no `process.exit`, no logging.
 */

import { toErrorMessage } from "./runtime-workspace";

/**
 * Machine-contract schema version (§4.2 / §10 Q2). Began at `"1"` with the P0 redesign
 * (the first stable contract; the prior always-JSON shape is not treated as a v0).
 * Additive fields keep this value; a shape/removal change bumps it. Bumped to `"2"` in P6
 * (§8/§9 deprecation cleanup) when the legacy top-level `errorMessage` string mirror on the
 * failure envelope was removed — a field removal that naive readers must be signalled about.
 */
export const CLI_SCHEMA_VERSION = "2";

/**
 * Closed set of structured failure classifications (§6.3). `internal_error` is the
 * catch-all. Each member maps deterministically to an exit code via
 * {@link exitCodeForErrorCode}.
 */
export const CLI_ERROR_CODES = [
	"workspace_not_found",
	"runtime_unreachable",
	"task_not_found",
	"file_not_found",
	"document_not_found",
	"connection_not_found",
	"invalid_argument",
	"validation_failed",
	"dependency_cycle",
	"write_not_allowed",
	"database_access_disabled",
	"storage_access_disabled",
	"passcode_not_set",
	"service_unsupported_platform",
	"internal_error",
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

/** Exit-code taxonomy (§6.2). Codes 3–5 are a deterministic refinement of the old blanket 1. */
export const CLI_EXIT_SUCCESS = 0;
export const CLI_EXIT_RUNTIME_ERROR = 1;
export const CLI_EXIT_USAGE_ERROR = 2;
export const CLI_EXIT_NOT_FOUND = 3;
export const CLI_EXIT_RUNTIME_UNREACHABLE = 4;
export const CLI_EXIT_CONFLICT = 5;

/** Map a structured `error.code` to its process exit code (§6.2). */
export function exitCodeForErrorCode(code: CliErrorCode): number {
	switch (code) {
		case "workspace_not_found":
		case "task_not_found":
		case "file_not_found":
		case "document_not_found":
		case "connection_not_found":
			return CLI_EXIT_NOT_FOUND;
		case "runtime_unreachable":
			return CLI_EXIT_RUNTIME_UNREACHABLE;
		case "dependency_cycle":
		case "write_not_allowed":
		case "database_access_disabled":
		case "storage_access_disabled":
			return CLI_EXIT_CONFLICT;
		case "invalid_argument":
		case "validation_failed":
		case "passcode_not_set":
		case "service_unsupported_platform":
		case "internal_error":
			return CLI_EXIT_RUNTIME_ERROR;
	}
}

/**
 * A failure carrying an explicit structured classification. Throw this from a command
 * handler to control the emitted `error.code` (and therefore the exit code); anything
 * else thrown is classified as `internal_error` by {@link classifyError}.
 */
export class CliError extends Error {
	readonly code: CliErrorCode;
	readonly details?: Record<string, unknown>;

	constructor(code: CliErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "CliError";
		this.code = code;
		if (details !== undefined) {
			this.details = details;
		}
	}
}

export interface CliEnvelopeError {
	code: CliErrorCode;
	message: string;
	details?: Record<string, unknown>;
}

/** A machine-stable, non-fatal advisory (e.g. a deprecated alias was used). */
export interface CliWarning {
	code: string;
	message: string;
}

/**
 * Prefix shared by every deprecation warning code (§8). The stderr deprecation note
 * (`cli-command-runner.ts`) keys off this prefix, so a `KANBAN_SUPPRESS_DEPRECATION=1`
 * silence only ever hides deprecation advisories, never other warning kinds.
 */
export const DEPRECATION_WARNING_PREFIX = "deprecated_";

/**
 * Build the warning emitted when a deprecated command alias was used (e.g. `task trash`,
 * which now runs `task done`). Surfaced as `warnings:[{code:"deprecated_alias"}]` in `--json`
 * and as a one-line stderr note for humans (design doc §3.3 rule 5 / §8).
 */
export function deprecatedAliasWarning(oldForm: string, newForm: string): CliWarning {
	return {
		code: "deprecated_alias",
		message: `\`${oldForm}\` is deprecated; use \`${newForm}\`.`,
	};
}

/**
 * Build the warning emitted when a deprecated flag supplied a value that is now a positional
 * argument (e.g. `--task-id` → `<id>`; design doc §3.3 rule 3 / §8).
 */
export function deprecatedFlagWarning(legacyFlagName: string, positionalLabel: string): CliWarning {
	return {
		code: "deprecated_flag",
		message: `\`${legacyFlagName}\` is deprecated; pass the ID as the positional \`${positionalLabel}\` instead.`,
	};
}

export interface CliSuccessEnvelope {
	schemaVersion: string;
	ok: true;
	command: string;
	data: Record<string, unknown>;
	warnings?: CliWarning[];
}

export interface CliFailureEnvelope {
	schemaVersion: string;
	ok: false;
	command: string;
	error: CliEnvelopeError;
	/**
	 * Machine-stable advisories that were already known when the command failed (e.g. a
	 * deprecated alias / flag was used before the handler threw). Mirrors the success
	 * envelope's `warnings[]` so an agent sees the same advisory regardless of outcome.
	 */
	warnings?: CliWarning[];
}

export type CliEnvelope = CliSuccessEnvelope | CliFailureEnvelope;

export function buildSuccessEnvelope(
	command: string,
	data: Record<string, unknown>,
	warnings?: CliWarning[],
): CliSuccessEnvelope {
	return {
		schemaVersion: CLI_SCHEMA_VERSION,
		ok: true,
		command,
		data,
		...(warnings && warnings.length > 0 ? { warnings } : {}),
	};
}

export function buildFailureEnvelope(
	command: string,
	error: CliEnvelopeError,
	warnings?: CliWarning[],
): CliFailureEnvelope {
	return {
		schemaVersion: CLI_SCHEMA_VERSION,
		ok: false,
		command,
		error,
		...(warnings && warnings.length > 0 ? { warnings } : {}),
	};
}

// Connection-level failures from the tRPC client / fetch when the runtime is down.
const RUNTIME_UNREACHABLE_REGEX = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|fetch failed|failed to fetch/i;

/** Classify an arbitrary thrown value into the structured `error` object (§6.3). */
export function classifyError(error: unknown): CliEnvelopeError {
	if (error instanceof CliError) {
		return {
			code: error.code,
			message: error.message,
			...(error.details !== undefined ? { details: error.details } : {}),
		};
	}
	const message = toErrorMessage(error);
	if (RUNTIME_UNREACHABLE_REGEX.test(message)) {
		return { code: "runtime_unreachable", message };
	}
	return { code: "internal_error", message };
}

export type OutputMode = "json" | "human";

export interface OutputModeInputs {
	/** `--json` flag (forces machine output). */
	jsonFlag?: boolean;
	/** `--human` flag (forces human output, even when piped). */
	humanFlag?: boolean;
	/** `KANBAN_OUTPUT` env value. */
	envValue?: string;
	/** Whether stdout is a TTY. */
	stdoutIsTTY: boolean;
}

/**
 * Resolve the output channel (§4.4). Precedence: explicit flag → `KANBAN_OUTPUT` env →
 * auto (non-TTY ⇒ machine for safe piping/agents, TTY ⇒ human).
 */
export function resolveOutputMode(inputs: OutputModeInputs): OutputMode {
	if (inputs.jsonFlag) {
		return "json";
	}
	if (inputs.humanFlag) {
		return "human";
	}
	const env = inputs.envValue?.trim().toLowerCase();
	if (env === "json") {
		return "json";
	}
	if (env === "human") {
		return "human";
	}
	return inputs.stdoutIsTTY ? "human" : "json";
}
