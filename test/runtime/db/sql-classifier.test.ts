import { describe, expect, it } from "vitest";

import { MultiStatementError } from "../../../src/db/errors";
import { classifySql } from "../../../src/db/policy/sql-classifier";

describe("classifySql", () => {
	it("classifies plain SELECT as read", () => {
		expect(classifySql("SELECT * FROM users", "postgres")).toBe("read");
	});

	it("classifies a CTE wrapping a SELECT as read", () => {
		expect(classifySql("WITH t AS (SELECT 1) SELECT * FROM t", "postgres")).toBe("read");
	});

	it("classifies INSERT/UPDATE/DELETE as write", () => {
		expect(classifySql("INSERT INTO users (id) VALUES (1)", "postgres")).toBe("write");
		expect(classifySql("UPDATE users SET id = 2", "mysql")).toBe("write");
		expect(classifySql("DELETE FROM users", "sqlite")).toBe("write");
	});

	it("detects a write hidden behind a CTE as write (the parser-not-regex case)", () => {
		// node-sql-parser's mysql grammar parses WITH…DELETE: the outer statement type
		// is `delete`, so a write wrapped in a CTE is still classified as a write — the
		// whole reason a real parser is used instead of a leading-keyword regex.
		expect(classifySql("WITH t AS (SELECT id FROM users) DELETE FROM users", "mysql")).toBe("write");
		// WITH…UPDATE parses under postgresql too.
		expect(classifySql("WITH t AS (SELECT id FROM users) UPDATE users SET id = 1", "postgres")).toBe("write");
	});

	it("fails closed (non-read) when a CTE-wrapped write hits a parser grammar gap", () => {
		// node-sql-parser's postgresql/sqlite grammars reject WITH…DELETE, so it cannot be
		// parsed. The classifier returns `unknown`, never `read`, so the policy still blocks
		// it for a read-only caller (defense-in-depth — the DB read-only session is the backstop).
		expect(classifySql("WITH t AS (SELECT id FROM users) DELETE FROM users", "postgres")).not.toBe("read");
		expect(classifySql("WITH t AS (SELECT id FROM users) DELETE FROM users", "postgres")).toBe("unknown");
	});

	it("classifies DDL as ddl", () => {
		expect(classifySql("CREATE TABLE x (id int)", "postgres")).toBe("ddl");
		expect(classifySql("DROP TABLE x", "postgres")).toBe("ddl");
	});

	it("treats unparseable SQL as unknown (fail closed)", () => {
		expect(classifySql("NOTSQL gibberish ;;", "postgres")).toBe("unknown");
	});

	it("rejects multiple statements", () => {
		expect(() => classifySql("SELECT 1; SELECT 2", "postgres")).toThrow(MultiStatementError);
	});

	it("classifies an allowlisted redis command as read", () => {
		expect(classifySql("HGETALL user:1", "redis")).toBe("read");
		expect(classifySql("scan 0", "redis")).toBe("read");
	});
	it("classifies a redis write command as write", () => {
		expect(classifySql("SET k v", "redis")).toBe("write");
		expect(classifySql("FLUSHALL", "redis")).toBe("write");
	});
});
