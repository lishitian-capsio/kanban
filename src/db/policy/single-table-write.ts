import { Parser } from "node-sql-parser";

import { createLogger } from "../../logging";
import { DbError } from "../errors";
import type { DatabaseEngine } from "../types";
import { sqlParserDialect } from "./sql-classifier";

const log = createLogger("db:single-table-write");

const parser = new Parser();

/** Operations the human row editor is allowed to emit. Everything else (select/DDL) is refused. */
const ALLOWED_OPS = new Set(["update", "insert", "delete", "replace"]);

/** The intended write target, so a builder bug or crafted input can't retarget another table. */
export interface SingleTableWriteTarget {
	schema: string;
	table: string;
}

/**
 * A generated write did not parse to exactly one single-table INSERT/UPDATE/DELETE against the
 * intended table. Defense-in-depth over the query builders: even though the SQL is generated (never
 * user-authored), this asserts the shape independently before it reaches the driver.
 */
export class SingleTableWriteError extends DbError {
	constructor(reason: string) {
		super(`refused write: ${reason}`);
	}
}

/**
 * Assert that `sql` is exactly one write statement (INSERT/UPDATE/DELETE) touching exactly the
 * intended `target` table — nothing else (no SELECT, no DDL, no join to a second table, no second
 * statement). Uses node-sql-parser's `tableList`, whose entries are `"<op>::<db>::<table>"`.
 *
 * This is the requirement-#4 guard: it runs in the human write path right before execution so a
 * generated statement can never affect a table other than the one the UI is editing. Fails closed —
 * an unparseable statement throws.
 */
export function assertSingleTableWrite(sql: string, engine: DatabaseEngine, target: SingleTableWriteTarget): void {
	let entries: string[];
	try {
		entries = parser.tableList(sql, { database: sqlParserDialect(engine) });
	} catch (error) {
		log.debug("single-table-write parse failed", { engine, error });
		throw new SingleTableWriteError("statement could not be parsed");
	}

	if (entries.length !== 1) {
		throw new SingleTableWriteError(`expected exactly one table, saw ${entries.length}`);
	}

	// `tableList` entries are "<op>::<db>::<table>". `db` is the literal string "null" when the
	// statement carries no schema qualifier.
	const entry = entries[0];
	if (!entry) {
		throw new SingleTableWriteError("no table found in statement");
	}
	const [op, db, table] = entry.split("::");
	if (!ALLOWED_OPS.has((op ?? "").toLowerCase())) {
		throw new SingleTableWriteError(`operation "${op}" is not an allowed row write`);
	}
	if (table !== target.table) {
		throw new SingleTableWriteError(`statement targets "${table}", expected "${target.table}"`);
	}
	// Only enforce the schema when the caller pins one AND the statement carries one — sqlite writes
	// (and unqualified statements) surface `db` as "null", which we accept for a schema-less target.
	if (target.schema && db !== "null" && db !== target.schema) {
		throw new SingleTableWriteError(`statement targets schema "${db}", expected "${target.schema}"`);
	}
}
