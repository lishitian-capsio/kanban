import { describe, expect, it } from "vitest";

import {
	DbConnectionError,
	DbPolicyError,
	DbQueryError,
	InvalidCursorError,
	MultiStatementError,
	QueryCancelledError,
	QueryTimeoutError,
	SingleRowGuardError,
} from "../../../src/db/errors";
import { normalizeQueryError, QueryExecutionError } from "../../../src/db/execution/query-error-normalizer";
import { SingleTableWriteError } from "../../../src/db/policy/single-table-write";

describe("normalizeQueryError", () => {
	it("maps a policy denial to a non-retryable policy_denied", () => {
		const n = normalizeQueryError(
			new DbPolicyError("agent caller is restricted to read-only operations", {
				caller: "agent",
				classification: "write",
			}),
		);
		expect(n.code).toBe("policy_denied");
		expect(n.retryable).toBe(false);
		expect(n.message).toContain("read-only");
	});

	it("maps multi-statement and invalid-cursor errors", () => {
		expect(normalizeQueryError(new MultiStatementError()).code).toBe("multi_statement");
		expect(normalizeQueryError(new InvalidCursorError()).code).toBe("invalid_cursor");
	});

	it("marks timeouts retryable and cancellations not", () => {
		const timeout = normalizeQueryError(new QueryTimeoutError(5000));
		expect(timeout.code).toBe("timeout");
		expect(timeout.retryable).toBe(true);
		expect(normalizeQueryError(new QueryCancelledError()).code).toBe("cancelled");
	});

	it("never leaks host/port from a connection error", () => {
		const n = normalizeQueryError(new DbConnectionError("connect ECONNREFUSED 10.20.30.40:5432"));
		expect(n.code).toBe("connection_failed");
		expect(n.retryable).toBe(true);
		expect(n.message).not.toContain("10.20.30.40");
		expect(n.message).not.toContain("5432");
	});

	it("preserves useful SQL error text but scrubs an embedded host", () => {
		const n = normalizeQueryError(new DbQueryError('relation "users" does not exist @ 192.168.1.5:5432'));
		expect(n.code).toBe("query_failed");
		expect(n.message).toContain('relation "users" does not exist');
		expect(n.message).not.toContain("192.168.1.5");
	});

	it("surfaces the guard/shape refusals as policy_denied with their safe message", () => {
		const guard = normalizeQueryError(new SingleRowGuardError(3));
		expect(guard.code).toBe("policy_denied");
		expect(guard.message).toContain("rolled back");
		const shape = normalizeQueryError(new SingleTableWriteError("statement targets \"other\", expected \"users\""));
		expect(shape.code).toBe("policy_denied");
		expect(shape.message).toContain("refused write");
	});

	it("does not echo an arbitrary unknown error message", () => {
		const n = normalizeQueryError(new Error("postgres://admin:hunter2@db.internal:5432/app failed"));
		expect(n.code).toBe("unknown");
		expect(n.message).not.toContain("hunter2");
		expect(n.message).not.toContain("db.internal");
	});

	it("tolerates non-Error throwables", () => {
		expect(normalizeQueryError("boom").code).toBe("unknown");
		expect(normalizeQueryError(null).code).toBe("unknown");
	});

	it("passes an already-normalized QueryExecutionError through unchanged", () => {
		const original = normalizeQueryError(new QueryTimeoutError(1000));
		const wrapped = new QueryExecutionError(original);
		expect(normalizeQueryError(wrapped)).toEqual(original);
	});
});
