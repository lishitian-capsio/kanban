import { describe, expect, it } from "vitest";

import type { BunSqlLike, BunSqlRows } from "../../../src/db/driver/bun-sql/bun-sql";
import { BunSqlDriver } from "../../../src/db/driver/bun-sql/bun-sql-driver";
import { cockroachdbDialect, timescaledbDialect } from "../../../src/db/driver/bun-sql/postgres-dialect";
import { mariadbDialect } from "../../../src/db/driver/bun-sql/mysql-dialect";
import type { EngineDialect } from "../../../src/db/driver/bun-sql/dialect";
import type { ConnectionConfig } from "../../../src/db/types";

interface RecordedCall {
	sql: string;
	values?: unknown[];
}

function fakeSql(): { sql: BunSqlLike; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const run = async (sql: string, values?: unknown[]): Promise<BunSqlRows> => {
		calls.push({ sql, values });
		if (sql.startsWith("SELECT")) {
			const result = [{ one: 1 }] as BunSqlRows;
			result.count = 1;
			return result;
		}
		return [] as BunSqlRows;
	};
	const sql: BunSqlLike = {
		unsafe: run,
		reserve: async () => ({ unsafe: run, release: () => {} }),
		connect: async () => sql,
		close: async () => {},
	};
	return { sql, calls };
}

async function runReadWithDeadline(dialect: EngineDialect): Promise<string[]> {
	const config: ConnectionConfig = { engine: dialect.engine, host: "h", database: "d", user: "u" };
	const { sql, calls } = fakeSql();
	const d = new BunSqlDriver(config, dialect, () => sql);
	await d.connect();
	await d.query({ sql: "SELECT 1 AS one", readOnly: true, timeoutMs: 1500 });
	await d.disconnect();
	return calls.map((c) => c.sql);
}

describe("cockroachdb dialect (postgres family)", () => {
	it("connects via the postgres Bun.SQL adapter", () => {
		const options = cockroachdbDialect.buildOptions({ engine: "cockroachdb", host: "h", database: "d", user: "u" });
		expect((options as { adapter?: string }).adapter).toBe("postgres");
	});

	it("opens a READ ONLY transaction and uses a session statement_timeout (not SET LOCAL) with a reset", async () => {
		const texts = await runReadWithDeadline(cockroachdbDialect);
		expect(texts).toContain("BEGIN TRANSACTION READ ONLY");
		expect(texts).toContain("SET statement_timeout = 1500");
		expect(texts).not.toContain("SET LOCAL statement_timeout = 1500");
		// session-scoped -> must be reset before the connection returns to the pool
		expect(texts).toContain("SET statement_timeout = 0");
	});
});

describe("timescaledb dialect (postgres family)", () => {
	it("is a plain postgres alias: postgres adapter + transaction-scoped SET LOCAL timeout, no reset", async () => {
		const options = timescaledbDialect.buildOptions({ engine: "timescaledb", host: "h", database: "d", user: "u" });
		expect((options as { adapter?: string }).adapter).toBe("postgres");
		expect(timescaledbDialect.resetTimeoutStatement).toBeNull();
		const texts = await runReadWithDeadline(timescaledbDialect);
		expect(texts).toContain("SET LOCAL statement_timeout = 1500");
	});
});

describe("mariadb dialect (mysql family)", () => {
	it("connects via the dedicated mariadb Bun.SQL adapter", () => {
		const options = mariadbDialect.buildOptions({ engine: "mariadb", host: "h", database: "d", user: "u" });
		expect((options as { adapter?: string }).adapter).toBe("mariadb");
	});

	it("uses max_statement_time in SECONDS (not mysql's ms max_execution_time) with a reset", async () => {
		const texts = await runReadWithDeadline(mariadbDialect);
		expect(texts).toContain("START TRANSACTION READ ONLY");
		// 1500ms -> 1.5s
		expect(texts).toContain("SET max_statement_time = 1.5");
		expect(texts).not.toContain("SET max_execution_time = 1500");
		expect(texts).toContain("SET max_statement_time = 0");
	});
});
