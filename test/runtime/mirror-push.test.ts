import { describe, expect, it, vi } from "vitest";

import type { RuntimeExtraPushRemote } from "../../src/core/api-contract";
import {
	formatMirrorPushOutput,
	type MirrorPushResult,
	normalizeExtraPushRemotes,
	pushToMirrorRemotes,
} from "../../src/workspace/mirror-push";

describe("normalizeExtraPushRemotes", () => {
	it("trims whitespace in name and url", () => {
		const result = normalizeExtraPushRemotes([{ name: "  gitee  ", url: "  https://gitee.com/o/r.git  " }]);
		expect(result).toEqual([{ name: "gitee", url: "https://gitee.com/o/r.git" }]);
	});

	it("drops entries with an empty name", () => {
		const result = normalizeExtraPushRemotes([
			{ name: "   ", url: "https://gitee.com/o/r.git" },
			{ name: "ok", url: "https://github.com/o/r.git" },
		]);
		expect(result).toEqual([{ name: "ok", url: "https://github.com/o/r.git" }]);
	});

	it("drops entries with an invalid url", () => {
		const result = normalizeExtraPushRemotes([
			{ name: "bad", url: "not a url" },
			{ name: "good", url: "git@github.com:o/r.git" },
		]);
		expect(result).toEqual([{ name: "good", url: "git@github.com:o/r.git" }]);
	});

	it("dedupes by url, keeping the first occurrence", () => {
		const result = normalizeExtraPushRemotes([
			{ name: "first", url: "https://gitee.com/o/r.git" },
			{ name: "second", url: "https://gitee.com/o/r.git" },
		]);
		expect(result).toEqual([{ name: "first", url: "https://gitee.com/o/r.git" }]);
	});

	it("returns an empty array for an empty input", () => {
		expect(normalizeExtraPushRemotes([])).toEqual([]);
	});
});

describe("pushToMirrorRemotes", () => {
	const remotes: RuntimeExtraPushRemote[] = [
		{ name: "gitee", url: "https://gitee.com/o/r.git" },
		{ name: "backup", url: "https://example.com/o/r.git" },
	];

	it("pushes to every remote and returns ok results in order", async () => {
		const pushOne = vi.fn().mockResolvedValue({ ok: true });
		const results = await pushToMirrorRemotes(remotes, "main", pushOne);
		expect(results).toEqual([
			{ name: "gitee", url: "https://gitee.com/o/r.git", ok: true },
			{ name: "backup", url: "https://example.com/o/r.git", ok: true },
		]);
		expect(pushOne).toHaveBeenCalledTimes(2);
		expect(pushOne).toHaveBeenNthCalledWith(1, remotes[0], "main");
		expect(pushOne).toHaveBeenNthCalledWith(2, remotes[1], "main");
	});

	it("degrades a remote that reports ok:false without affecting the others", async () => {
		const pushOne = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, error: "auth failed" })
			.mockResolvedValueOnce({ ok: true });
		const results = await pushToMirrorRemotes(remotes, "main", pushOne);
		expect(results).toEqual([
			{ name: "gitee", url: "https://gitee.com/o/r.git", ok: false, error: "auth failed" },
			{ name: "backup", url: "https://example.com/o/r.git", ok: true },
		]);
	});

	it("degrades a remote whose pushOne throws and still pushes the rest", async () => {
		const pushOne = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ ok: true });
		const results = await pushToMirrorRemotes(remotes, "main", pushOne);
		expect(results[0]).toEqual({
			name: "gitee",
			url: "https://gitee.com/o/r.git",
			ok: false,
			error: "network down",
		});
		expect(results[1]).toEqual({ name: "backup", url: "https://example.com/o/r.git", ok: true });
		expect(pushOne).toHaveBeenCalledTimes(2);
	});

	it("returns an empty array when there are no remotes", async () => {
		const pushOne = vi.fn();
		const results = await pushToMirrorRemotes([], "main", pushOne);
		expect(results).toEqual([]);
		expect(pushOne).not.toHaveBeenCalled();
	});
});

describe("formatMirrorPushOutput", () => {
	it("returns an empty string when there are no results", () => {
		expect(formatMirrorPushOutput([])).toBe("");
	});

	it("summarizes when every mirror push succeeded", () => {
		const results: MirrorPushResult[] = [
			{ name: "gitee", url: "https://gitee.com/o/r.git", ok: true },
			{ name: "backup", url: "https://example.com/o/r.git", ok: true },
		];
		const output = formatMirrorPushOutput(results);
		expect(output).toContain("2");
		expect(output).toContain("gitee");
	});

	it("includes the remote name and error for a failed mirror push", () => {
		const results: MirrorPushResult[] = [
			{ name: "gitee", url: "https://gitee.com/o/r.git", ok: false, error: "auth failed" },
			{ name: "backup", url: "https://example.com/o/r.git", ok: true },
		];
		const output = formatMirrorPushOutput(results);
		expect(output).toContain("gitee");
		expect(output).toContain("auth failed");
	});
});
