/** Shared logging contract. Kept dependency-free so both the pure formatters
 * and the winston-backed facade can import it. */
import type { LogLevel } from "./log-level";

/** Arbitrary structured context attached to a log record (e.g. taskId,
 * workspaceId, agentId, error). */
export type LogFields = Record<string, unknown>;

/** A single log event before it has been timestamped and serialized. */
export interface LogRecord {
	level: LogLevel;
	/** Module / subsystem prefix, e.g. "proxy-fetch" or "runtime". */
	namespace: string;
	message: string;
	fields: LogFields;
}

/** A namespaced logger. Each method takes a message and optional structured
 * fields; `child` returns a logger with additional base fields merged in. */
export interface Logger {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
	child(fields: LogFields): Logger;
}

/** Where a formatted record is ultimately written. Injectable so the facade is
 * testable without winston or real I/O. */
export type LogSink = (record: LogRecord) => void;
