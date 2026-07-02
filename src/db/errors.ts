import type { DbCaller, SqlClassification } from "./types";

/** Base class for every error this layer throws, so callers can branch on `instanceof DbError`. */
export class DbError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** A statement was blocked by the security policy (read-only connection or restricted caller). */
export class DbPolicyError extends DbError {
	constructor(
		message: string,
		readonly details?: { caller: DbCaller; classification: SqlClassification },
	) {
		super(message);
	}
}

/** The SQL contained more than one statement; multi-statement execution is refused. */
export class MultiStatementError extends DbError {
	constructor() {
		super("multiple SQL statements are not allowed in a single request");
	}
}

/** Establishing or using the underlying connection failed. */
export class DbConnectionError extends DbError {}

/** No machine-home credential is configured for this connection id. */
export class CredentialNotConfiguredError extends DbError {
	constructor(readonly connId: string) {
		super(`no credential configured for connection "${connId}"`);
	}
}

/** The requested engine has no registered driver factory. */
export class UnsupportedEngineError extends DbError {
	constructor(readonly engine: string) {
		super(`unsupported database engine: "${engine}"`);
	}
}

/** The driver's native query failed; wraps the engine error with a sanitized message. */
export class DbQueryError extends DbError {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
	}
}

/** A pagination cursor token could not be decoded (corrupt or foreign). */
export class InvalidCursorError extends DbError {
	constructor() {
		super("invalid pagination cursor");
	}
}

/** A query exceeded its execution deadline and was abandoned. */
export class QueryTimeoutError extends DbError {
	constructor(readonly timeoutMs: number) {
		super(`query exceeded the ${timeoutMs}ms execution timeout`);
	}
}

/** A query was cancelled by the caller (abort signal) before it finished. */
export class QueryCancelledError extends DbError {
	constructor() {
		super("query was cancelled");
	}
}

/**
 * A guarded single-row write (the no-primary-key edit path) matched more than one row and was
 * rolled back. The full-row WHERE could not uniquely identify the target, so the edit is refused
 * rather than silently changing several rows.
 */
export class SingleRowGuardError extends DbError {
	constructor(readonly matchedRows: number) {
		super(
			`refused edit: matched ${matchedRows} rows, but this table has no primary key so exactly one row must ` +
				`match. The change was rolled back — no rows were modified.`,
		);
	}
}
