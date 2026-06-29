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
 *    caller to be `human`. The `agent` and `cli` callers are always capped read-only —
 *    writes on an `allowWrites` connection are reserved for the human Database UI (whose
 *    structured, primary-key-gated row edits are the only sanctioned write path).
 *  - `unknown` (unparseable) fails closed: it is treated as a write.
 */
export function assertOperationAllowed(input: AccessPolicyInput): ResolvedOperation {
	const classification = classifySql(input.sql, input.engine);
	if (classification === "read") {
		return { classification, readOnly: true };
	}

	// Non-read from here on. Only the human UI may write, and only on a write-enabled connection.
	// `agent`/`cli` are always capped read-only regardless of the connection's `allowWrites`.
	if (input.caller !== "human") {
		throw new DbPolicyError(`${input.caller} caller is restricted to read-only operations`, {
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
