import {
	DbConnectionError,
	DbError,
	DbPolicyError,
	DbQueryError,
	InvalidCursorError,
	MultiStatementError,
	QueryCancelledError,
	QueryTimeoutError,
	SingleRowGuardError,
} from "../errors";
import { SingleTableWriteError } from "../policy/single-table-write";

/**
 * Stable, transport-agnostic error codes the three upper entries (agent / human / cli)
 * branch on. Kept narrow on purpose — UI/MCP/CLI map these to their own surfaces.
 */
export type QueryErrorCode =
	| "policy_denied"
	| "multi_statement"
	| "invalid_cursor"
	| "timeout"
	| "cancelled"
	| "connection_failed"
	| "query_failed"
	| "unknown";

/** A normalized, caller-safe view of a failed query. Carries no connection secrets. */
export interface NormalizedQueryError {
	code: QueryErrorCode;
	/** User-facing message, already scrubbed of host/port/credential material. */
	message: string;
	/** Whether retrying the same request might succeed (timeout / transient connection). */
	retryable: boolean;
}

/**
 * The error the executor throws. Wraps the {@link NormalizedQueryError} (the safe surface)
 * and keeps the original cause for internal logging only — `cause` is never serialized
 * into the normalized payload.
 */
export class QueryExecutionError extends DbError {
	readonly cause?: unknown;
	constructor(
		readonly normalized: NormalizedQueryError,
		options?: { cause?: unknown },
	) {
		super(normalized.message);
		this.cause = options?.cause;
	}
}

/**
 * Redact material that could expose a connection: credentialed URIs, explicit
 * password/pwd assignments, and IPv4 host[:port] tokens. Deliberately conservative so
 * useful SQL diagnostics ("relation … does not exist", "syntax error near …") survive.
 */
function scrubSensitive(message: string): string {
	return message
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^@\s]+@[^\s]+/gi, "[redacted-uri]")
		.replace(/\b(password|pwd)\s*=\s*\S+/gi, "$1=[redacted]")
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[redacted-host]");
}

function normalized(code: QueryErrorCode, message: string, retryable: boolean): NormalizedQueryError {
	return { code, message, retryable };
}

/**
 * Map any thrown value to a {@link NormalizedQueryError}. Policy / multi-statement /
 * cursor / timeout / cancellation errors carry their own safe messages. Connection errors
 * collapse to a generic message (their native text leaks host/port/user). Driver query
 * errors keep their (scrubbed) SQL diagnostic. Everything else is opaque.
 */
export function normalizeQueryError(error: unknown): NormalizedQueryError {
	if (error instanceof QueryExecutionError) {
		return error.normalized;
	}
	if (error instanceof DbPolicyError) {
		return normalized("policy_denied", error.message, false);
	}
	// The row-guard rollback and the single-table shape guard are deliberate, safe refusals — their
	// messages carry no secrets and explain what to do, so surface them (as a policy denial) verbatim.
	if (error instanceof SingleRowGuardError || error instanceof SingleTableWriteError) {
		return normalized("policy_denied", error.message, false);
	}
	if (error instanceof MultiStatementError) {
		return normalized("multi_statement", error.message, false);
	}
	if (error instanceof InvalidCursorError) {
		return normalized("invalid_cursor", error.message, false);
	}
	if (error instanceof QueryTimeoutError) {
		return normalized("timeout", error.message, true);
	}
	if (error instanceof QueryCancelledError) {
		return normalized("cancelled", error.message, false);
	}
	if (error instanceof DbConnectionError) {
		// Native connect errors embed host:port and the auth user — never surface them.
		return normalized("connection_failed", "failed to connect to the database", true);
	}
	if (error instanceof DbQueryError) {
		return normalized("query_failed", scrubSensitive(error.message), false);
	}
	return normalized("unknown", "an unexpected database error occurred", false);
}
