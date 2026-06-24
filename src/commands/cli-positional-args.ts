/**
 * Resolve an entity id that the redesign promoted from a flag to a positional (design doc
 * §3.3 rule 3, phase P2). The new canonical form passes the id as a positional argument
 * (`task update <id>`); the pre-redesign flag (`--task-id <id>`) is retained as a
 * deprecated alias for the compatibility window (§8). When the legacy flag supplies the
 * value, callers surface a `deprecated_flag` warning two ways — a one-line stderr note for
 * humans and a `warnings[]` entry for machines (see `cli-command-runner.ts`).
 *
 * This module is pure: no I/O, no stderr, no `process.exit`. It only computes the resolved
 * id plus an optional {@link CliWarning}, so the dual-parse logic stays unit-testable.
 */

import { CliError, type CliWarning, deprecatedFlagWarning } from "./cli-envelope";

export interface ResolveIdArgs {
	/** The positional argument value (the new canonical form), if present. */
	positional: string | undefined;
	/** The retained legacy flag value (the deprecated form), if present. */
	legacyFlagValue: string | undefined;
	/** The legacy flag name as written on the command line, e.g. `--task-id`. */
	legacyFlagName: string;
	/** Positional label shown in the deprecation message (defaults to `<id>`). */
	positionalLabel?: string;
	/** Error message thrown when neither source supplies a value (required variant only). */
	missingMessage?: string;
}

export interface ResolvedRequiredId {
	id: string;
	/** Present iff the value came from the deprecated legacy flag. */
	warning?: CliWarning;
}

export interface ResolvedOptionalId {
	/** Absent iff neither the positional nor the legacy flag supplied a value. */
	id?: string;
	/** Present iff the value came from the deprecated legacy flag. */
	warning?: CliWarning;
}

/** Trim a candidate value to `undefined` when it is missing or blank. */
function clean(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Resolve an optional id: positional preferred, legacy flag as a deprecated fallback. Returns
 * an empty object when neither is present (the caller has another way to target the command,
 * e.g. `--column` on `task done`).
 */
export function resolveOptionalId(args: ResolveIdArgs): ResolvedOptionalId {
	const positional = clean(args.positional);
	if (positional) {
		return { id: positional };
	}
	const legacy = clean(args.legacyFlagValue);
	if (legacy) {
		return {
			id: legacy,
			warning: deprecatedFlagWarning(args.legacyFlagName, args.positionalLabel ?? "<id>"),
		};
	}
	return {};
}

/**
 * Resolve a required id: positional preferred, legacy flag as a deprecated fallback. Throws
 * a {@link CliError} (`invalid_argument`) when neither source supplies a value.
 */
export function resolveRequiredId(args: ResolveIdArgs): ResolvedRequiredId {
	const resolved = resolveOptionalId(args);
	if (resolved.id === undefined) {
		const label = args.positionalLabel ?? "<id>";
		throw new CliError(
			"invalid_argument",
			args.missingMessage ?? `Missing required id. Pass it as the positional ${label} argument.`,
		);
	}
	return { id: resolved.id, ...(resolved.warning ? { warning: resolved.warning } : {}) };
}
