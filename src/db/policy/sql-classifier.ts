import { Parser } from "node-sql-parser";

import { createLogger } from "../../logging";
import { MultiStatementError } from "../errors";
import type { DatabaseEngine, SqlClassification } from "../types";

const log = createLogger("db:sql-classifier");

const parser = new Parser();

/** node-sql-parser dialect key per engine. */
const PARSER_DIALECT: Record<DatabaseEngine, string> = {
	postgres: "postgresql",
	mysql: "mysql",
	sqlite: "sqlite",
};

/** Statement AST `type` values that only read data. Everything else is non-read. */
const READ_TYPES = new Set(["select"]);
const WRITE_TYPES = new Set(["insert", "update", "delete", "replace"]);
const DDL_TYPES = new Set(["create", "drop", "alter", "truncate", "rename"]);

interface StatementAst {
	type?: string;
}

/**
 * Classify a single SQL statement as read / write / ddl / unknown for the security
 * policy. Uses node-sql-parser so a write hidden behind a CTE or comment is still
 * detected. Throws {@link MultiStatementError} for more than one statement. An
 * unparseable statement classifies as `unknown` (the policy treats that as a write —
 * fail closed).
 */
export function classifySql(sql: string, engine: DatabaseEngine): SqlClassification {
	let ast: StatementAst | StatementAst[];
	try {
		ast = parser.astify(sql, { database: PARSER_DIALECT[engine] }) as StatementAst | StatementAst[];
	} catch (error) {
		log.debug("sql parse failed; classifying as unknown", { engine, error });
		return "unknown";
	}

	const statements = Array.isArray(ast) ? ast : [ast];
	if (statements.length === 0) {
		return "unknown";
	}
	if (statements.length > 1) {
		throw new MultiStatementError();
	}

	const type = (statements[0]?.type ?? "").toLowerCase();
	if (READ_TYPES.has(type)) {
		return "read";
	}
	if (WRITE_TYPES.has(type)) {
		return "write";
	}
	if (DDL_TYPES.has(type)) {
		return "ddl";
	}
	return "unknown";
}
