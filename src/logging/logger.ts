/**
 * Kanban's unified logging facade.
 *
 * `createLogger(namespace)` is the single entry point for all Kanban-owned
 * code; nothing should call `console.*` directly for diagnostics. Output goes
 * to stdout/stderr by default (pretty on a TTY, JSON when piped) and can
 * additionally be persisted to a rotating file under the machine-local
 * `~/.kanban/logs/` — runtime data that is never committed to the repo.
 *
 * Note: this is Kanban-owned and intentionally separate from the vendored
 * oh-my-pi logger in `src/agent-sdk/shared/logger.ts` (which logs to
 * `~/.omp/logs/`). Do not merge the two.
 */
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { type LogFormat, formatRecord, resolveLogFormat } from "./log-format";
import { isLevelEnabled, type LogLevel, resolveLogLevel } from "./log-level";
import type { LogFields, Logger, LogRecord, LogSink } from "./types";

const RUNTIME_HOME_DIR = ".kanban";
const LOGS_SUBDIR = "logs";

/** Machine-local logs directory: `~/.kanban/logs` (override via KANBAN_LOG_DIR).
 * This lives outside any repo so logs are never tracked by git. */
export function getLogsDir(): string {
	return process.env.KANBAN_LOG_DIR?.trim() || join(homedir(), RUNTIME_HOME_DIR, LOGS_SUBDIR);
}

function isEnvFlagEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function stdoutIsTTY(): boolean {
	return Boolean(process.stdout?.isTTY);
}

function envLevel() {
	return { KANBAN_LOG_LEVEL: process.env.KANBAN_LOG_LEVEL, KANBAN_DEBUG_MODE: process.env.KANBAN_DEBUG_MODE };
}

function envFormat() {
	return { KANBAN_LOG_FORMAT: process.env.KANBAN_LOG_FORMAT };
}

/** Console sink: pretty/JSON to stdout, warn+error to stderr. */
function buildConsoleSink(format: LogFormat, fileLogger?: winston.Logger): LogSink {
	return (record: LogRecord) => {
		const meta = { timestamp: new Date().toISOString(), pid: process.pid };
		const stream = record.level === "warn" || record.level === "error" ? process.stderr : process.stdout;
		stream.write(`${formatRecord(record, meta, format)}\n`);
		// The file copy is always structured JSON regardless of console format.
		fileLogger?.log(record.level, formatRecord(record, meta, "json"));
	};
}

/** Rotating-file winston logger. winston only handles rotation/retention; the
 * line is pre-formatted by {@link formatRecord} and passed through verbatim. */
function buildFileLogger(dir: string): winston.Logger {
	fs.mkdirSync(dir, { recursive: true });
	return winston.createLogger({
		level: "debug",
		format: winston.format.printf((info) => String(info.message)),
		transports: [
			new DailyRotateFile({
				dirname: dir,
				filename: "kanban.%DATE%.log",
				datePattern: "YYYY-MM-DD",
				maxSize: "10m",
				maxFiles: 5,
				zippedArchive: true,
			}),
		],
		exitOnError: false,
	});
}

interface LoggingState {
	threshold: LogLevel;
	sink: LogSink;
	fileLogger?: winston.Logger;
}

function defaultState(): LoggingState {
	return {
		threshold: resolveLogLevel(envLevel()),
		sink: buildConsoleSink(resolveLogFormat(envFormat(), stdoutIsTTY())),
	};
}

let state: LoggingState = defaultState();

export interface ConfigureLoggingOptions {
	/** Active threshold; defaults to the env-resolved level. */
	level?: LogLevel;
	/** Output format; defaults to env / TTY detection. */
	format?: LogFormat;
	/** Also persist to a rotating file; defaults to the `KANBAN_LOG_FILE` env. */
	logToFile?: boolean;
	/** File directory; defaults to {@link getLogsDir}. */
	logDir?: string;
	/** Replace the sink outright (test seam / custom transports). */
	sink?: LogSink;
}

/**
 * (Re)configure the active logger. Call once during startup; safe to call
 * again to apply changed settings. Passing `sink` bypasses the built-in
 * console/file transports entirely.
 */
export function configureLogging(options: ConfigureLoggingOptions = {}): void {
	state.fileLogger?.close();
	state.threshold = options.level ?? resolveLogLevel(envLevel());

	if (options.sink) {
		state = { threshold: state.threshold, sink: options.sink };
		return;
	}

	const format = options.format ?? resolveLogFormat(envFormat(), stdoutIsTTY());
	const logToFile = options.logToFile ?? isEnvFlagEnabled(process.env.KANBAN_LOG_FILE);
	const fileLogger = logToFile ? buildFileLogger(options.logDir ?? getLogsDir()) : undefined;
	state = { threshold: state.threshold, sink: buildConsoleSink(format, fileLogger), fileLogger };
}

/** Reset to env-derived defaults. Test-only; also closes any file transport. */
export function resetLoggingForTest(): void {
	state.fileLogger?.close();
	state = defaultState();
}

function emit(namespace: string, level: LogLevel, baseFields: LogFields, message: string, fields?: LogFields): void {
	if (!isLevelEnabled(level, state.threshold)) return;
	const merged: LogFields = fields ? { ...baseFields, ...fields } : { ...baseFields };
	try {
		state.sink({ level, namespace, message, fields: merged });
	} catch {
		// Logging must never crash the caller.
	}
}

/** Create a namespaced logger. Optional `baseFields` (e.g. workspaceId,
 * agentId) are merged into every record and can be overridden per call. */
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
