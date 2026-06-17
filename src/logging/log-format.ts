/**
 * Pure record formatting. Two shapes from one record:
 *  - `pretty`: human-readable single line for a terminal/TTY.
 *  - `json`:   one structured JSON object per line for parsing / files.
 *
 * No winston, no I/O — so every formatting rule is unit-testable in isolation.
 */
import type { LogLevel } from "./log-level";
import type { LogFields, LogRecord } from "./types";

export const LOG_FORMATS = ["pretty", "json"] as const;

export type LogFormat = (typeof LOG_FORMATS)[number];

export interface LogFormatEnv {
	KANBAN_LOG_FORMAT?: string;
}

/** Metadata stamped onto a record at write time. */
export interface LogMeta {
	timestamp: string;
	pid: number;
}

function isLogFormat(value: string): value is LogFormat {
	return (LOG_FORMATS as readonly string[]).includes(value);
}

/**
 * Resolve the output format: an explicit `KANBAN_LOG_FORMAT` wins; otherwise
 * `pretty` on an interactive terminal and `json` when piped/redirected (so
 * supervisors and files get structured output by default).
 */
export function resolveLogFormat(env: LogFormatEnv, isTTY: boolean): LogFormat {
	const explicit = env.KANBAN_LOG_FORMAT?.trim().toLowerCase();
	if (explicit && isLogFormat(explicit)) {
		return explicit;
	}
	return isTTY ? "pretty" : "json";
}

/**
 * JSON.stringify replacer that unwraps {@link Error} instances. Error's own
 * properties are non-enumerable, so a plain `JSON.stringify(err)` yields `"{}"`
 * and forensic logs lose every useful field.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		const out: Record<string, unknown> = {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
		const errAsRecord = value as unknown as Record<string, unknown>;
		for (const k in errAsRecord) out[k] = errAsRecord[k];
		if (value.cause !== undefined) out.cause = value.cause;
		return out;
	}
	return value;
}

const LEVEL_LABEL: Record<LogLevel, string> = {
	debug: "DEBUG",
	info: "INFO ",
	warn: "WARN ",
	error: "ERROR",
};

/** "2026-06-17T09:00:00.000Z" -> "09:00:00.000" for compact terminal output. */
function shortTime(timestamp: string): string {
	const match = timestamp.match(/T(\d{2}:\d{2}:\d{2}\.\d{3})/);
	return match ? match[1] : timestamp;
}

function hasFields(fields: LogFields): boolean {
	for (const _ in fields) {
		return true;
	}
	return false;
}

function formatPrettyFields(fields: LogFields): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		let rendered: string;
		if (value instanceof Error) {
			rendered = value.stack ?? `${value.name}: ${value.message}`;
		} else if (typeof value === "string") {
			rendered = value;
		} else {
			rendered = JSON.stringify(value, jsonReplacer);
		}
		parts.push(`${key}=${rendered}`);
	}
	return parts.join(" ");
}

/** Serialize a record to a single line in the requested format. */
export function formatRecord(record: LogRecord, meta: LogMeta, format: LogFormat): string {
	if (format === "json") {
		const entry: Record<string, unknown> = {
			timestamp: meta.timestamp,
			level: record.level,
			pid: meta.pid,
			namespace: record.namespace,
			message: record.message,
		};
		for (const [key, value] of Object.entries(record.fields)) {
			entry[key] = value;
		}
		return JSON.stringify(entry, jsonReplacer);
	}

	const head = `${shortTime(meta.timestamp)} ${LEVEL_LABEL[record.level]} [${record.namespace}] ${record.message}`;
	return hasFields(record.fields) ? `${head} ${formatPrettyFields(record.fields)}` : head;
}
