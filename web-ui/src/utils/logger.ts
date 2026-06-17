/**
 * Browser-side logging facade — the web-ui counterpart to the runtime's
 * `src/logging` module. Same `createLogger(namespace)` shape (namespaced,
 * structured fields, level threshold) but the only sink is the devtools
 * console (browsers can't write files). Nothing in web-ui should call
 * `console.*` directly for diagnostics.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

export interface Logger {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
	child(fields: LogFields): Logger;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const CONSOLE_METHOD: Record<LogLevel, (...args: unknown[]) => void> = {
	debug: (...args) => console.debug(...args),
	info: (...args) => console.info(...args),
	warn: (...args) => console.warn(...args),
	error: (...args) => console.error(...args),
};

function resolveDefaultLevel(): LogLevel {
	return import.meta.env?.DEV ? "debug" : "info";
}

let threshold: LogLevel = resolveDefaultLevel();

/** (Re)configure the active threshold. Call once at startup if needed. */
export function configureBrowserLogging(options: { level: LogLevel }): void {
	threshold = options.level;
}

function emit(namespace: string, level: LogLevel, base: LogFields, message: string, fields?: LogFields): void {
	if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[threshold]) return;
	const merged = fields ? { ...base, ...fields } : base;
	const prefixed = `[${namespace}] ${message}`;
	const hasFields = Object.keys(merged).length > 0;
	if (hasFields) {
		CONSOLE_METHOD[level](prefixed, merged);
	} else {
		CONSOLE_METHOD[level](prefixed);
	}
}

/** Create a namespaced browser logger. Optional `baseFields` are merged into
 * every record and can be overridden per call. */
export function createLogger(namespace: string, baseFields: LogFields = {}): Logger {
	const base = { ...baseFields };
	return {
		debug: (message, fields) => emit(namespace, "debug", base, message, fields),
		info: (message, fields) => emit(namespace, "info", base, message, fields),
		warn: (message, fields) => emit(namespace, "warn", base, message, fields),
		error: (message, fields) => emit(namespace, "error", base, message, fields),
		child: (fields) => createLogger(namespace, { ...base, ...fields }),
	};
}
