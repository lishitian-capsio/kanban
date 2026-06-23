import { DbPolicyError } from "../errors";
import type { DatabaseEngine, DbCaller, SqlClassification } from "../types";
import { classifySql } from "./sql-classifier";

export interface AccessPolicyInput {
	sql: string;
	engine: DatabaseEngine;
	caller: DbCaller;
	/** Whether the connection record opted into writes (`allowWrites`). */
	connectionAllowsWrites: boolean;
}

export interface ResolvedOperation {
	classification: SqlClassification;
	/** The session mode the driver must open. Reads (and blocked-then-allowed nothing) are read-only. */
	readOnly: boolean;
}

/**
 * The single adjudication point shared by every upper entry (agent / human / cli).
 *
 * Rules (defense-in-depth — the driver ALSO opens a read-only DB session for `readOnly`):
 *  - A `read` statement is always allowed and runs read-only.
 *  - A `write`/`ddl`/`unknown` statement requires the connection to allow writes AND the
 *    caller not to be `agent`. The agent caller is always capped read-only.
 *  - `unknown` (unparseable) fails closed: it is treated as a write.
 */
export function assertOperationAllowed(input: AccessPolicyInput): ResolvedOperation {
	const classification = classifySql(input.sql, input.engine);
	if (classification === "read") {
		return { classification, readOnly: true };
	}

	// Non-read from here on. Agent is always restricted; otherwise the connection must opt in.
	if (input.caller === "agent") {
		throw new DbPolicyError("agent caller is restricted to read-only operations", {
			caller: input.caller,
			classification,
		});
	}
	if (!input.connectionAllowsWrites) {
		throw new DbPolicyError("connection is read-only; writes are not permitted", {
			caller: input.caller,
			classification,
		});
	}
	return { classification, readOnly: false };
}
