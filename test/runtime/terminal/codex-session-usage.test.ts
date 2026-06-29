import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCodexRolloutUsage, readCodexSessionUsage } from "../../../src/terminal/codex-session-usage";

/**
 * Build one Codex `event_msg`/`token_count` JSONL line carrying a cumulative
 * `total_token_usage` block (Codex's real rollout shape). `cached_input_tokens`
 * is a subset of `input_tokens` and `reasoning_output_tokens` a subset of
 * `output_tokens`, mirroring how Codex actually reports them.
 */
function tokenCountLine(opts: {
	input?: number;
	cachedInput?: number;
	output?: number;
	reasoningOutput?: number;
	total?: number;
}): string {
	const input = opts.input ?? 0;
	const output = opts.output ?? 0;
	return JSON.stringify({
		timestamp: "2026-06-25T06:09:38.176Z",
		type: "event_msg",
		payload: {
			type: "token_count",
			info: {
				total_token_usage: {
					input_tokens: input,
					cached_input_tokens: opts.cachedInput ?? 0,
					output_tokens: output,
					reasoning_output_tokens: opts.reasoningOutput ?? 0,
					total_tokens: opts.total ?? input + output,
				},
				last_token_usage: {
					input_tokens: input,
					cached_input_tokens: opts.cachedInput ?? 0,
					output_tokens: output,
					reasoning_output_tokens: opts.reasoningOutput ?? 0,
					total_tokens: opts.total ?? input + output,
				},
				model_context_window: 258400,
			},
		},
	});
}

describe("parseCodexRolloutUsage", () => {
	it("returns null for empty content", () => {
		expect(parseCodexRolloutUsage("")).toBeNull();
	});

	it("returns null when no token_count event is present", () => {
		const content = [
			JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/p" } }),
			JSON.stringify({ type: "response_item", payload: { type: "message" } }),
			"",
		].join("\n");
		expect(parseCodexRolloutUsage(content)).toBeNull();
	});

	it("maps total_token_usage directly (cache already folded into input)", () => {
		// input_tokens already includes cached_input_tokens, output_tokens already
		// includes reasoning — so they map straight through, no addition.
		const content = tokenCountLine({ input: 39364, cachedInput: 21888, output: 181, reasoningOutput: 101 });
		expect(parseCodexRolloutUsage(content)).toEqual({
			inputTokens: 39364,
			outputTokens: 181,
			totalTokens: 39545,
		});
	});

	it("uses the LAST token_count event since total_token_usage is cumulative", () => {
		// Codex re-emits a cumulative running total on every turn — the final event
		// holds the whole session's usage; summing events would multiply-count.
		const content = [
			tokenCountLine({ input: 39364, output: 181 }),
			tokenCountLine({ input: 79049, output: 265 }),
		].join("\n");
		expect(parseCodexRolloutUsage(content)).toEqual({
			inputTokens: 79049,
			outputTokens: 265,
			totalTokens: 79314,
		});
	});

	it("computes totalTokens as input + output (ignores a wrong reported total)", () => {
		const content = tokenCountLine({ input: 100, output: 20, total: 99999 });
		expect(parseCodexRolloutUsage(content)).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
		});
	});

	it("tolerates a torn trailing line from a crash mid-write", () => {
		const content = [
			tokenCountLine({ input: 100, output: 20 }),
			'{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_to', // truncated
		].join("\n");
		expect(parseCodexRolloutUsage(content)).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
		});
	});

	it("skips non-token_count events and falls back to the prior valid total", () => {
		const content = [
			tokenCountLine({ input: 100, output: 20 }),
			JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } }),
			JSON.stringify({ type: "response_item", payload: { type: "function_call_output" } }),
		].join("\n");
		expect(parseCodexRolloutUsage(content)).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
		});
	});

	it("ignores a token_count event with no total_token_usage block", () => {
		const content = [
			tokenCountLine({ input: 100, output: 20 }),
			JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { model_context_window: 1 } } }),
		].join("\n");
		expect(parseCodexRolloutUsage(content)).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
		});
	});

	it("treats missing, negative, and non-numeric token fields as zero", () => {
		const content = JSON.stringify({
			type: "event_msg",
			payload: {
				type: "token_count",
				info: {
					total_token_usage: { input_tokens: -5, output_tokens: "oops", cached_input_tokens: 40 },
				},
			},
		});
		expect(parseCodexRolloutUsage(content)).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		});
	});
});

describe("readCodexSessionUsage", () => {
	let sessionsDir: string | null = null;

	beforeEach(() => {
		sessionsDir = mkdtempSync(join(tmpdir(), "kanban-codex-usage-"));
	});

	afterEach(() => {
		if (sessionsDir) {
			rmSync(sessionsDir, { recursive: true, force: true });
		}
		sessionsDir = null;
	});

	it("returns null when no rollout matches the cwd", async () => {
		const usage = await readCodexSessionUsage({ sessionsDir: sessionsDir ?? "", cwd: "/home/dev/proj" });
		expect(usage).toBeNull();
	});

	it("reads cumulative usage from the rollout whose session_meta cwd matches", async () => {
		const cwd = "/home/dev/proj";
		const dir = join(sessionsDir ?? "", "2026", "06", "25");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "rollout-2026-06-25T14-09-07-019efd65-7d9b-7803-be21-5bb48edab5e4.jsonl");
		const content = [
			JSON.stringify({ type: "session_meta", payload: { id: "019efd65-7d9b-7803-be21-5bb48edab5e4", cwd } }),
			tokenCountLine({ input: 39364, output: 181 }),
			tokenCountLine({ input: 79049, output: 265 }),
		].join("\n");
		writeFileSync(file, content, "utf8");

		const usage = await readCodexSessionUsage({ sessionsDir: sessionsDir ?? "", cwd });
		expect(usage).toEqual({ inputTokens: 79049, outputTokens: 265, totalTokens: 79314 });
	});

	it("ignores a rollout whose cwd does not match the task worktree", async () => {
		const dir = join(sessionsDir ?? "", "2026", "06", "25");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "rollout-2026-06-25T14-09-07-019efd65-7d9b-7803-be21-5bb48edab5e4.jsonl");
		const content = [
			JSON.stringify({
				type: "session_meta",
				payload: { id: "019efd65-7d9b-7803-be21-5bb48edab5e4", cwd: "/other" },
			}),
			tokenCountLine({ input: 100, output: 20 }),
		].join("\n");
		writeFileSync(file, content, "utf8");

		const usage = await readCodexSessionUsage({ sessionsDir: sessionsDir ?? "", cwd: "/home/dev/proj" });
		expect(usage).toBeNull();
	});
});
