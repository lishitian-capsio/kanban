import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPiToolSet } from "../../src/agent-sdk/kanban/pi-tools-bridge";
import type { AgentTool } from "../../src/agent-sdk/types";

function getTool(cwd: string, name: string): AgentTool<any> {
	const tool = buildPiToolSet({ cwd }).find((t) => t.name === name);
	if (!tool) throw new Error(`tool not found: ${name}`);
	return tool;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	if (!first || first.type !== "text") throw new Error("expected text content");
	return first.text ?? "";
}

function makeWorkspace(): string {
	return mkdtempSync(join(tmpdir(), "pi-tools-test-"));
}

describe("execute_command", () => {
	it("does not block the event loop while the command runs", async () => {
		const cwd = makeWorkspace();
		const tool = getTool(cwd, "execute_command");

		// A synchronous (execSync) implementation blocks the entire event loop
		// inside execute() before its promise is even returned, so a timer
		// scheduled right after the call cannot fire until the command exits.
		// An async implementation yields control immediately, so the 50ms timer
		// wins the race against a 0.5s command.
		const commandPromise = tool.execute("id", { command: "sleep 0.5" });
		const winner = await Promise.race([
			commandPromise.then(() => "command"),
			new Promise<string>((resolve) => setTimeout(() => resolve("timer"), 50)),
		]);
		expect(winner).toBe("timer");
		await commandPromise;
	});

	it("returns command stdout", async () => {
		const cwd = makeWorkspace();
		const tool = getTool(cwd, "execute_command");
		const result = await tool.execute("id", { command: "echo hello-kanban" });
		expect(result.isError).toBeFalsy();
		expect(firstText(result)).toContain("hello-kanban");
	});

	it("captures stderr and exit code on failure", async () => {
		const cwd = makeWorkspace();
		const tool = getTool(cwd, "execute_command");
		const result = await tool.execute("id", { command: "echo oops >&2; exit 3" });
		expect(result.isError).toBe(true);
		const text = firstText(result);
		expect(text).toContain("oops");
		expect(text).toContain("exit code: 3");
	});
});

describe("search_files", () => {
	it("returns matching lines with file paths", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "sample.txt"), "alpha\nfind-me here\nbeta\n");
		const tool = getTool(cwd, "search_files");
		const result = await tool.execute("id", { pattern: "find-me" });
		expect(firstText(result)).toContain("find-me here");
	});

	it("returns a friendly message when there are no matches", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "sample.txt"), "nothing relevant\n");
		const tool = getTool(cwd, "search_files");
		const result = await tool.execute("id", { pattern: "zzz-no-match-zzz" });
		expect(firstText(result)).toBe("No matches found.");
	});
});
