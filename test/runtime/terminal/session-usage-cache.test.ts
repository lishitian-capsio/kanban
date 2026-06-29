import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	isUsageCacheFresh,
	type SessionUsageReadCache,
	statUsageFile,
} from "../../../src/terminal/session-usage-cache";

let tempRoot: string | null = null;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "kanban-usage-cache-"));
});

afterEach(() => {
	if (tempRoot) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
	tempRoot = null;
});

describe("statUsageFile", () => {
	it("returns mtime + size for an existing file", async () => {
		const file = join(tempRoot ?? "", "t.jsonl");
		writeFileSync(file, "hello", "utf8");
		const sig = await statUsageFile(file);
		expect(sig?.size).toBe(5);
		expect(typeof sig?.mtimeMs).toBe("number");
	});

	it("returns null for a missing file (never throws)", async () => {
		const sig = await statUsageFile(join(tempRoot ?? "", "missing.jsonl"));
		expect(sig).toBeNull();
	});
});

describe("isUsageCacheFresh", () => {
	const cache: SessionUsageReadCache = {
		filePath: "/a/b.jsonl",
		mtimeMs: 1_000,
		size: 42,
		usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
	};

	it("is fresh when path + mtime + size all match", () => {
		expect(isUsageCacheFresh(cache, "/a/b.jsonl", { mtimeMs: 1_000, size: 42 })).toBe(true);
	});

	it("is stale when the size differs (file grew)", () => {
		expect(isUsageCacheFresh(cache, "/a/b.jsonl", { mtimeMs: 1_000, size: 43 })).toBe(false);
	});

	it("is stale when the mtime differs", () => {
		expect(isUsageCacheFresh(cache, "/a/b.jsonl", { mtimeMs: 2_000, size: 42 })).toBe(false);
	});

	it("is stale when the path differs (different transcript)", () => {
		expect(isUsageCacheFresh(cache, "/a/other.jsonl", { mtimeMs: 1_000, size: 42 })).toBe(false);
	});

	it("is stale for a null/undefined memo", () => {
		expect(isUsageCacheFresh(null, "/a/b.jsonl", { mtimeMs: 1_000, size: 42 })).toBe(false);
		expect(isUsageCacheFresh(undefined, "/a/b.jsonl", { mtimeMs: 1_000, size: 42 })).toBe(false);
	});

	it("reflects an mtime set via utimes on a real file", async () => {
		const file = join(tempRoot ?? "", "u.jsonl");
		writeFileSync(file, "abc", "utf8");
		utimesSync(file, 5_000, 5_000);
		const sig = await statUsageFile(file);
		const memo: SessionUsageReadCache = { filePath: file, mtimeMs: sig?.mtimeMs ?? 0, size: 3, usage: null };
		expect(isUsageCacheFresh(memo, file, { mtimeMs: 5_000_000, size: 3 })).toBe(true);
	});
});
