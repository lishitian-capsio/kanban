import { describe, expect, it } from "vitest";

import { InvalidCursorError } from "../../../src/db/errors";
import {
	buildBoundedQuery,
	capRowsByBytes,
	decodeOffsetCursor,
	encodeOffsetCursor,
	finalizePage,
} from "../../../src/db/execution/query-bounds";

describe("buildBoundedQuery", () => {
	it("wraps a read query in a LIMIT subquery fetching pageSize+1 rows", () => {
		const bounded = buildBoundedQuery({
			sql: "SELECT id, name FROM users",
			classification: "read",
			page: { pageSize: 50 },
		});
		expect(bounded.wrapped).toBe(true);
		expect(bounded.offset).toBe(0);
		expect(bounded.fetchLimit).toBe(51);
		expect(bounded.sql).toBe("SELECT * FROM (SELECT id, name FROM users) AS _kanban_q LIMIT 51 OFFSET 0");
	});

	it("strips a trailing semicolon before wrapping", () => {
		const bounded = buildBoundedQuery({
			sql: "SELECT 1 ;  ",
			classification: "read",
			page: { pageSize: 10 },
		});
		expect(bounded.sql).toBe("SELECT * FROM (SELECT 1) AS _kanban_q LIMIT 11 OFFSET 0");
	});

	it("applies the decoded cursor offset", () => {
		const bounded = buildBoundedQuery({
			sql: "SELECT 1",
			classification: "read",
			page: { pageSize: 25, cursor: encodeOffsetCursor(75) },
		});
		expect(bounded.offset).toBe(75);
		expect(bounded.sql).toBe("SELECT * FROM (SELECT 1) AS _kanban_q LIMIT 26 OFFSET 75");
	});

	it("does NOT wrap a write statement", () => {
		const bounded = buildBoundedQuery({
			sql: "DELETE FROM t",
			classification: "write",
			page: { pageSize: 50 },
		});
		expect(bounded.wrapped).toBe(false);
		expect(bounded.sql).toBe("DELETE FROM t");
	});

	it("does NOT wrap an unknown/unparseable statement", () => {
		const bounded = buildBoundedQuery({
			sql: "VACUUM weird",
			classification: "unknown",
			page: { pageSize: 50 },
		});
		expect(bounded.wrapped).toBe(false);
		expect(bounded.sql).toBe("VACUUM weird");
	});

	it("never wraps a redis read (self-bounded by SCAN/range)", () => {
		const r = buildBoundedQuery({ sql: "SCAN 0", classification: "read", engine: "redis", page: { pageSize: 10 } });
		expect(r.wrapped).toBe(false);
		expect(r.sql).toBe("SCAN 0");
	});
});

describe("offset cursor", () => {
	it("round-trips an offset", () => {
		expect(decodeOffsetCursor(encodeOffsetCursor(42))).toBe(42);
	});

	it("treats an absent cursor as offset 0", () => {
		expect(decodeOffsetCursor(null)).toBe(0);
		expect(decodeOffsetCursor(undefined)).toBe(0);
	});

	it("throws InvalidCursorError on a malformed token", () => {
		expect(() => decodeOffsetCursor("not-a-cursor")).toThrow(InvalidCursorError);
	});
});

describe("finalizePage", () => {
	it("detects more rows, trims the probe row, and emits the next cursor", () => {
		const fetched = [{ a: 1 }, { a: 2 }, { a: 3 }]; // pageSize=2 + 1 probe
		const page = finalizePage(fetched, { pageSize: 2, offset: 10 });
		expect(page.rows).toEqual([{ a: 1 }, { a: 2 }]);
		expect(page.hasMore).toBe(true);
		expect(decodeOffsetCursor(page.nextCursor)).toBe(12);
	});

	it("reports no more rows and a null cursor on a short page", () => {
		const fetched = [{ a: 1 }];
		const page = finalizePage(fetched, { pageSize: 2, offset: 0 });
		expect(page.rows).toEqual([{ a: 1 }]);
		expect(page.hasMore).toBe(false);
		expect(page.nextCursor).toBeNull();
		expect(page.truncatedByBytes).toBe(false);
	});

	it("truncates a page by bytes and resumes the cursor after the returned rows", () => {
		// Each row {"a":N} serializes to 7 bytes; pageSize=3 with a probe row.
		const fetched = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }];
		const page = finalizePage(fetched, { pageSize: 3, offset: 0, maxBytes: 14 });
		expect(page.rows).toEqual([{ a: 1 }, { a: 2 }]);
		expect(page.truncatedByBytes).toBe(true);
		expect(page.hasMore).toBe(true);
		expect(decodeOffsetCursor(page.nextCursor)).toBe(2);
	});
});

describe("capRowsByBytes", () => {
	it("stops accumulating rows once the byte budget is exceeded", () => {
		const result = capRowsByBytes([{ a: 1 }, { a: 2 }, { a: 3 }], 14);
		expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
		expect(result.truncated).toBe(true);
	});

	it("always returns at least one row to guarantee pagination progress", () => {
		const result = capRowsByBytes([{ a: 1 }], 1);
		expect(result.rows).toHaveLength(1);
		expect(result.truncated).toBe(true);
	});

	it("returns every row when they fit", () => {
		const result = capRowsByBytes([{ a: 1 }, { a: 2 }], 1000);
		expect(result.rows).toHaveLength(2);
		expect(result.truncated).toBe(false);
	});

	it("does not throw on bigint cell values", () => {
		const result = capRowsByBytes([{ a: 10n }], 1000);
		expect(result.rows).toHaveLength(1);
	});
});
