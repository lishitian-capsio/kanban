import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	encodeClaudeProjectSlug,
	parseClaudeSessionUsage,
	readClaudeSessionUsage,
	resolveClaudeSessionFilePath,
} from "../../../src/terminal/claude-session-usage";

/** Build one `type:"assistant"` JSONL line with the given usage + message id. */
function assistantLine(opts: {
	id?: string | null;
	input?: number;
	cacheCreation?: number;
	cacheRead?: number;
	output?: number;
}): string {
	const message: Record<string, unknown> = {
		role: "assistant",
		usage: {
			input_tokens: opts.input ?? 0,
			cache_creation_input_tokens: opts.cacheCreation ?? 0,
			cache_read_input_tokens: opts.cacheRead ?? 0,
			output_tokens: opts.output ?? 0,
		},
	};
	if (opts.id !== null) {
		message.id = opts.id ?? "msg_default";
	}
	return JSON.stringify({ type: "assistant", message });
}

describe("encodeClaudeProjectSlug", () => {
	it("replaces slashes and dots with dashes (mirrors Claude's project dir naming)", () => {
		expect(encodeClaudeProjectSlug("/home/developer/code/kanban/.kanban/worktrees/ff967/kanban")).toBe(
			"-home-developer-code-kanban--kanban-worktrees-ff967-kanban",
		);
	});
});

describe("resolveClaudeSessionFilePath", () => {
	it("builds <base>/projects/<slug>/<sessionId>.jsonl", () => {
		const path = resolveClaudeSessionFilePath({
			cwd: "/home/dev/proj",
			sessionId: "abc-123",
			claudeConfigDir: "/home/dev/.claude",
		});
		expect(path).toBe("/home/dev/.claude/projects/-home-dev-proj/abc-123.jsonl");
	});
});

describe("parseClaudeSessionUsage", () => {
	it("returns null for empty content", () => {
		expect(parseClaudeSessionUsage("")).toBeNull();
	});

	it("returns null when no assistant line carries usage", () => {
		const content = [JSON.stringify({ type: "user", message: { role: "user" } }), ""].join("\n");
		expect(parseClaudeSessionUsage(content)).toBeNull();
	});

	it("folds cache_creation and cache_read into inputTokens", () => {
		const content = assistantLine({ id: "m1", input: 100, cacheCreation: 30, cacheRead: 20, output: 5 });
		expect(parseClaudeSessionUsage(content)).toEqual({
			inputTokens: 150,
			outputTokens: 5,
			totalTokens: 155,
		});
	});

	it("counts a message id only once even when repeated across content-block lines", () => {
		// A single assistant turn writes one line per content block, all sharing the
		// same message.id and identical usage — naive summing would multiply-count.
		const line = assistantLine({ id: "m1", input: 100, output: 10 });
		const content = [line, line, line, line].join("\n");
		expect(parseClaudeSessionUsage(content)).toEqual({
			inputTokens: 100,
			outputTokens: 10,
			totalTokens: 110,
		});
	});

	it("sums usage across distinct messages", () => {
		const content = [
			assistantLine({ id: "m1", input: 100, output: 10 }),
			assistantLine({ id: "m2", input: 50, output: 5 }),
		].join("\n");
		expect(parseClaudeSessionUsage(content)).toEqual({
			inputTokens: 150,
			outputTokens: 15,
			totalTokens: 165,
		});
	});

	it("tolerates a torn trailing line from a crash mid-write", () => {
		const content = [
			assistantLine({ id: "m1", input: 100, output: 10 }),
			'{"type":"assistant","message":{"role":"assistant","usage":{"input_to', // truncated
		].join("\n");
		expect(parseClaudeSessionUsage(content)).toEqual({
			inputTokens: 100,
			outputTokens: 10,
			totalTokens: 110,
		});
	});

	it("ignores non-assistant lines and assistant lines missing usage", () => {
		const content = [
			JSON.stringify({ type: "user", message: { role: "user", usage: { input_tokens: 999 } } }),
			JSON.stringify({ type: "assistant", message: { role: "assistant" } }),
			assistantLine({ id: "m1", input: 100, output: 10 }),
		].join("\n");
		expect(parseClaudeSessionUsage(content)).toEqual({
			inputTokens: 100,
			outputTokens: 10,
			totalTokens: 110,
		});
	});

	it("counts assistant lines that have no message id (each as a distinct contribution)", () => {
		const content = [
			assistantLine({ id: null, input: 100, output: 10 }),
			assistantLine({ id: null, input: 50, output: 5 }),
		].join("\n");
		expect(parseClaudeSessionUsage(content)).toEqual({
			inputTokens: 150,
			outputTokens: 15,
			totalTokens: 165,
		});
	});

	it("treats missing, negative, and non-numeric token fields as zero", () => {
		const content = [
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					id: "m1",
					usage: { input_tokens: -5, output_tokens: "oops", cache_read_input_tokens: 40 },
				},
			}),
		].join("\n");
		expect(parseClaudeSessionUsage(content)).toEqual({
			inputTokens: 40,
			outputTokens: 0,
			totalTokens: 40,
		});
	});
});

describe("readClaudeSessionUsage", () => {
	let tempRoot: string | null = null;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "kanban-claude-usage-"));
	});

	afterEach(() => {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
		tempRoot = null;
	});

	it("returns null when the session id is missing", async () => {
		const { usage } = await readClaudeSessionUsage({
			cwd: "/home/dev/proj",
			sessionId: "   ",
			claudeConfigDir: tempRoot ?? undefined,
		});
		expect(usage).toBeNull();
	});

	it("returns null when the session file does not exist", async () => {
		const { usage } = await readClaudeSessionUsage({
			cwd: "/home/dev/proj",
			sessionId: "missing-session",
			claudeConfigDir: tempRoot ?? undefined,
		});
		expect(usage).toBeNull();
	});

	it("reads and accumulates usage from an on-disk session file", async () => {
		const cwd = "/home/dev/proj";
		const sessionId = "11111111-1111-1111-1111-111111111111";
		const filePath = resolveClaudeSessionFilePath({ cwd, sessionId, claudeConfigDir: tempRoot ?? undefined });
		mkdirSync(join(filePath, ".."), { recursive: true });
		const line = assistantLine({ id: "m1", input: 100, cacheRead: 20, output: 10 });
		writeFileSync(filePath, [line, line].join("\n"), "utf8");

		const { usage } = await readClaudeSessionUsage({ cwd, sessionId, claudeConfigDir: tempRoot ?? undefined });
		expect(usage).toEqual({ inputTokens: 120, outputTokens: 10, totalTokens: 130 });
	});

	it("reuses the cached parse when the file is unchanged and re-reads after it grows", async () => {
		const cwd = "/home/dev/proj";
		const sessionId = "22222222-2222-2222-2222-222222222222";
		const filePath = resolveClaudeSessionFilePath({ cwd, sessionId, claudeConfigDir: tempRoot ?? undefined });
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(filePath, assistantLine({ id: "m1", input: 100, output: 10 }), "utf8");

		const first = await readClaudeSessionUsage({ cwd, sessionId, claudeConfigDir: tempRoot ?? undefined });
		expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 10, totalTokens: 110 });
		expect(first.cache?.filePath).toBe(filePath);

		// Unchanged file → same memo object returned (no re-parse).
		const second = await readClaudeSessionUsage({ cwd, sessionId, claudeConfigDir: tempRoot ?? undefined }, first.cache);
		expect(second.cache).toBe(first.cache);
		expect(second.usage).toEqual(first.usage);

		// Grow the file (new message id, larger size) → memo is stale → re-parse.
		writeFileSync(
			filePath,
			[assistantLine({ id: "m1", input: 100, output: 10 }), assistantLine({ id: "m2", input: 50, output: 5 })].join("\n"),
			"utf8",
		);
		const third = await readClaudeSessionUsage({ cwd, sessionId, claudeConfigDir: tempRoot ?? undefined }, second.cache);
		expect(third.cache).not.toBe(second.cache);
		expect(third.usage).toEqual({ inputTokens: 150, outputTokens: 15, totalTokens: 165 });
	});
});
