import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { type GlobalCliOptions, readGlobalCliOptions } from "../../src/commands/cli-command-runner";
import { parseCliPortOption } from "../../src/core/runtime-endpoint";

/**
 * Build a minimal program that mirrors the real global-flag surface (design doc §6.1):
 * the flags are declared once on the root and a deep `task list` subcommand reads them via
 * `readGlobalCliOptions(this)`. This pins the load-bearing commander behavior that P1 relies
 * on — a global value is honored regardless of whether it appears before or after the
 * subcommand (the AGENTS.md "re-declared option routes to the parent" gotcha) — without
 * spawning the real CLI or touching a workspace.
 */
function buildProgram(): { program: Command; captured: () => GlobalCliOptions | null } {
	let captured: GlobalCliOptions | null = null;
	const program = new Command();
	program
		.name("kanban")
		.option("--project-path <path>")
		.option("--host <ip>")
		.option("--port <number|auto>", "port", parseCliPortOption)
		.option("--json")
		.option("--human")
		.option("--no-color")
		.option("--quiet")
		.exitOverride();
	const task = program.command("task");
	task.command("list").action(async function (this: Command) {
		captured = readGlobalCliOptions(this);
	});
	return { program, captured: () => captured };
}

async function run(argv: string[]): Promise<GlobalCliOptions> {
	const { program, captured } = buildProgram();
	await program.parseAsync(argv, { from: "user" });
	const result = captured();
	if (!result) {
		throw new Error("action did not run");
	}
	return result;
}

describe("readGlobalCliOptions", () => {
	it("reads --project-path when it appears BEFORE the subcommand", async () => {
		const globals = await run(["--project-path", "/repo", "task", "list"]);
		expect(globals.projectPath).toBe("/repo");
	});

	it("reads --project-path when it appears AFTER the subcommand", async () => {
		const globals = await run(["task", "list", "--project-path", "/repo"]);
		expect(globals.projectPath).toBe("/repo");
	});

	it("reads --project-path when it appears mid-path", async () => {
		const globals = await run(["task", "--project-path", "/repo", "list"]);
		expect(globals.projectPath).toBe("/repo");
	});

	it("defaults are: no projectPath, json/human/quiet false, color true", async () => {
		const globals = await run(["task", "list"]);
		expect(globals).toEqual({
			projectPath: undefined,
			json: false,
			human: false,
			color: true,
			quiet: false,
		});
	});

	it("maps --json / --human / --quiet / --no-color regardless of position", async () => {
		const globals = await run(["task", "list", "--json", "--quiet", "--no-color"]);
		expect(globals.json).toBe(true);
		expect(globals.quiet).toBe(true);
		expect(globals.color).toBe(false);

		const humanFirst = await run(["--human", "task", "list"]);
		expect(humanFirst.human).toBe(true);
		expect(humanFirst.json).toBe(false);
	});
});
