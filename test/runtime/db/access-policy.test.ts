import { describe, expect, it } from "vitest";

import { DbPolicyError } from "../../../src/db/errors";
import { assertOperationAllowed } from "../../../src/db/policy/access-policy";
import type { DbCaller } from "../../../src/db/types";

function run(sql: string, caller: DbCaller, connectionAllowsWrites: boolean) {
	return assertOperationAllowed({ sql, engine: "postgres", caller, connectionAllowsWrites });
}

describe("assertOperationAllowed", () => {
	it("allows reads for every caller regardless of write permission", () => {
		for (const caller of ["agent", "human", "cli"] as DbCaller[]) {
			const res = run("SELECT 1", caller, false);
			expect(res.classification).toBe("read");
			expect(res.readOnly).toBe(true);
		}
	});

	it("blocks writes when the connection is read-only", () => {
		expect(() => run("DELETE FROM users", "human", false)).toThrow(DbPolicyError);
	});

	it("allows writes for the human caller when the connection opts in", () => {
		const res = run("DELETE FROM users", "human", true);
		expect(res.classification).toBe("write");
		expect(res.readOnly).toBe(false);
	});

	it("ALWAYS caps the agent caller to read-only even when the connection allows writes", () => {
		expect(() => run("DELETE FROM users", "agent", true)).toThrow(DbPolicyError);
	});

	it("ALWAYS caps the cli caller to read-only even when the connection allows writes", () => {
		// The `kanban db` CLI is the agent's channel: writes/DDL stay with the human Database UI.
		expect(() => run("DELETE FROM users", "cli", true)).toThrow(DbPolicyError);
		expect(() => run("CREATE TABLE x (id int)", "cli", true)).toThrow(DbPolicyError);
	});

	it("treats unknown (unparseable) SQL as a blocked write for a read-only connection", () => {
		expect(() => run("NOTSQL ;;", "human", false)).toThrow(DbPolicyError);
	});

	it("blocks DDL on a read-only connection", () => {
		expect(() => run("CREATE TABLE x (id int)", "cli", false)).toThrow(DbPolicyError);
	});
});
