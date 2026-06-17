/**
 * Log levels and the rules for resolving the active threshold from the
 * environment. Pure and dependency-free so it can be unit-tested and reused on
 * either side of the runtime without importing winston or touching the
 * filesystem.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Ordering used to decide whether a record clears the active threshold. */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

function isLogLevel(value: string): value is LogLevel {
	return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Truthy in the same way the rest of the codebase reads boolean-ish env vars. */
function isEnvFlagEnabled(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

export interface LogLevelEnv {
	KANBAN_LOG_LEVEL?: string;
	KANBAN_DEBUG_MODE?: string;
}

/**
 * Resolve the active log level. An explicit `KANBAN_LOG_LEVEL` always wins;
 * otherwise a truthy `KANBAN_DEBUG_MODE` drops to `debug` (aligning with the
 * existing debug-mode convention); otherwise {@link DEFAULT_LOG_LEVEL}.
 */
export function resolveLogLevel(env: LogLevelEnv): LogLevel {
	const explicit = env.KANBAN_LOG_LEVEL?.trim().toLowerCase();
	if (explicit) {
		return isLogLevel(explicit) ? explicit : DEFAULT_LOG_LEVEL;
	}
	if (isEnvFlagEnabled(env.KANBAN_DEBUG_MODE)) {
		return "debug";
	}
	return DEFAULT_LOG_LEVEL;
}

/** True when a record at `candidate` should be emitted given `threshold`. */
export function isLevelEnabled(candidate: LogLevel, threshold: LogLevel): boolean {
	return LOG_LEVEL_PRIORITY[candidate] >= LOG_LEVEL_PRIORITY[threshold];
}
