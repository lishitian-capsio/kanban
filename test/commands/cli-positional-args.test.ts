import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/commands/cli-envelope";
import { resolveOptionalId, resolveRequiredId } from "../../src/commands/cli-positional-args";

describe("resolveRequiredId", () => {
	it("prefers the positional and emits no deprecation warning", () => {
		const result = resolveRequiredId({
			positional: "abc",
			legacyFlagValue: undefined,
			legacyFlagName: "--task-id",
		});
		expect(result).toEqual({ id: "abc" });
	});

	it("falls back to the legacy flag and emits a deprecated_flag warning", () => {
		const result = resolveRequiredId({
			positional: undefined,
			legacyFlagValue: "abc",
			legacyFlagName: "--task-id",
		});
		expect(result.id).toBe("abc");
		expect(result.warning).toEqual({
			code: "deprecated_flag",
			message: "`--task-id` is deprecated; pass the ID as the positional `<id>` instead.",
		});
	});

	it("prefers the positional even when the legacy flag is also present (no warning)", () => {
		const result = resolveRequiredId({
			positional: "positional-id",
			legacyFlagValue: "flag-id",
			legacyFlagName: "--task-id",
		});
		expect(result).toEqual({ id: "positional-id" });
	});

	it("trims surrounding whitespace from either source", () => {
		expect(resolveRequiredId({ positional: "  abc  ", legacyFlagValue: undefined, legacyFlagName: "--id" }).id).toBe(
			"abc",
		);
		expect(resolveRequiredId({ positional: undefined, legacyFlagValue: "  xyz ", legacyFlagName: "--id" }).id).toBe(
			"xyz",
		);
	});

	it("throws a CliError(invalid_argument) when neither source is present", () => {
		expect(() =>
			resolveRequiredId({ positional: undefined, legacyFlagValue: undefined, legacyFlagName: "--id" }),
		).toThrow(CliError);
		try {
			resolveRequiredId({ positional: "   ", legacyFlagValue: "", legacyFlagName: "--id" });
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).code).toBe("invalid_argument");
		}
	});

	it("uses a custom positional label and missing message when provided", () => {
		const result = resolveRequiredId({
			positional: undefined,
			legacyFlagValue: "dep-1",
			legacyFlagName: "--dependency-id",
			positionalLabel: "<dependency-id>",
		});
		expect(result.warning?.message).toBe(
			"`--dependency-id` is deprecated; pass the ID as the positional `<dependency-id>` instead.",
		);
		try {
			resolveRequiredId({
				positional: undefined,
				legacyFlagValue: undefined,
				legacyFlagName: "--dependency-id",
				missingMessage: "task unlink requires a dependency id.",
			});
			throw new Error("expected throw");
		} catch (error) {
			expect((error as CliError).message).toBe("task unlink requires a dependency id.");
		}
	});
});

describe("resolveOptionalId", () => {
	it("returns an empty result when neither source is present (no throw, no warning)", () => {
		expect(
			resolveOptionalId({ positional: undefined, legacyFlagValue: undefined, legacyFlagName: "--task-id" }),
		).toEqual({});
	});

	it("prefers the positional without a warning", () => {
		expect(resolveOptionalId({ positional: "abc", legacyFlagValue: undefined, legacyFlagName: "--task-id" })).toEqual(
			{
				id: "abc",
			},
		);
	});

	it("falls back to the legacy flag and warns", () => {
		const result = resolveOptionalId({ positional: undefined, legacyFlagValue: "abc", legacyFlagName: "--task-id" });
		expect(result.id).toBe("abc");
		expect(result.warning?.code).toBe("deprecated_flag");
	});
});

/**
 * End-to-end commander dual-parse: a command with an optional `[id]` positional plus the
 * retained legacy `--task-id` flag must resolve the same id whether the caller passes it
 * positionally (new form) or via the flag (old form). This pins the wiring P2 depends on.
 */
describe("commander positional + legacy flag dual-parse", () => {
	function buildProgram(): { program: Command; captured: () => { id: string; warned: boolean } | null } {
		let captured: { id: string; warned: boolean } | null = null;
		const program = new Command();
		program.exitOverride();
		const task = program.command("task");
		task
			.command("update")
			.argument("[id]", "Task ID (positional, preferred over --task-id).")
			.option("--task-id <id>", "Deprecated: pass the ID as the positional <id> instead.")
			.action(function (this: Command, idArg: string | undefined, options: { taskId?: string }) {
				const resolved = resolveRequiredId({
					positional: idArg,
					legacyFlagValue: options.taskId,
					legacyFlagName: "--task-id",
				});
				captured = { id: resolved.id, warned: resolved.warning !== undefined };
			});
		return { program, captured: () => captured };
	}

	async function run(argv: string[]): Promise<{ id: string; warned: boolean }> {
		const { program, captured } = buildProgram();
		await program.parseAsync(argv, { from: "user" });
		const result = captured();
		if (!result) {
			throw new Error("action did not run");
		}
		return result;
	}

	it("resolves the new positional form `task update <id>`", async () => {
		expect(await run(["task", "update", "abc"])).toEqual({ id: "abc", warned: false });
	});

	it("resolves the old flag form `task update --task-id <id>` with a deprecation warning", async () => {
		expect(await run(["task", "update", "--task-id", "abc"])).toEqual({ id: "abc", warned: true });
	});
});
