import { describe, expect, it } from "vitest";

import {
	CredentialNotConfiguredError,
	DbError,
	DbPolicyError,
	MultiStatementError,
	UnsupportedEngineError,
} from "../../../src/db/errors";

describe("db errors", () => {
	it("DbPolicyError is a DbError and carries a reason", () => {
		const err = new DbPolicyError("connection is read-only");
		expect(err).toBeInstanceOf(DbError);
		expect(err).toBeInstanceOf(DbPolicyError);
		expect(err.message).toBe("connection is read-only");
		expect(err.name).toBe("DbPolicyError");
	});

	it("UnsupportedEngineError names the engine", () => {
		const err = new UnsupportedEngineError("clickhouse");
		expect(err).toBeInstanceOf(DbError);
		expect(err.message).toContain("clickhouse");
	});

	it("MultiStatementError and CredentialNotConfiguredError extend DbError", () => {
		expect(new MultiStatementError()).toBeInstanceOf(DbError);
		expect(new CredentialNotConfiguredError("conn-1")).toBeInstanceOf(DbError);
		expect(new CredentialNotConfiguredError("conn-1").message).toContain("conn-1");
	});
});
