import { Argument, Command, Option } from "commander";
import { describe, expect, it } from "vitest";

import { CLI_ERROR_CODES, CLI_SCHEMA_VERSION, CliError, exitCodeForErrorCode } from "../../src/commands/cli-envelope";
import {
	buildCliSchema,
	type CliCommandSchema,
	type CliSchemaManifest,
	narrowCliSchema,
	registerSchemaCommand,
} from "../../src/commands/cli-schema";
import { registerDbCommand } from "../../src/commands/db";
import { registerFileCommand } from "../../src/commands/file";
import { registerHomeThreadCommand } from "../../src/commands/home-thread";
import { registerHooksCommand } from "../../src/commands/hooks";
import { registerPasscodeAliasCommand, registerRemoteCommand } from "../../src/commands/remote";
import { registerServiceCommand } from "../../src/commands/service";
import { registerStorageCommand } from "../../src/commands/storage";
import { registerTaskCommand } from "../../src/commands/task";
import { registerVaultCommand } from "../../src/commands/vault";
import { parseCliPortOption } from "../../src/core/runtime-endpoint";

/**
 * Build the real command tree the way `createProgram` (cli.ts) does — same global flags and
 * the same `register*` calls — without importing cli.ts itself (its module body calls
 * `run()` on import). This keeps the "contains every command" assertion drift-proof: the
 * manifest is generated from exactly the commander definitions the CLI ships.
 */
function buildRealManifest(): CliSchemaManifest {
	const program = new Command();
	program
		.name("kanban")
		.option("--project-path <path>", "Workspace to operate on.")
		.option("--host <ip>", "Host IP to bind the server to.")
		.option("--port <number|auto>", "Runtime port (1-65535) or auto.", parseCliPortOption)
		.option("--json", "Emit machine-readable JSON output.")
		.option("--human", "Force human-readable output even when piped.")
		.option("--no-color", "Disable ANSI color in human output.")
		.option("--quiet", "Suppress the human summary footer / spinners.");

	registerTaskCommand(program);
	registerFileCommand(program);
	registerVaultCommand(program);
	registerDbCommand(program);
	registerStorageCommand(program);
	registerHomeThreadCommand(program);
	registerHooksCommand(program);
	registerServiceCommand(program);
	registerRemoteCommand(program);
	registerPasscodeAliasCommand(program);
	registerSchemaCommand(program, { kanbanVersion: "9.9.9-test" });

	return buildCliSchema(program, { kanbanVersion: "9.9.9-test" });
}

function commandById(manifest: CliSchemaManifest, id: string): CliCommandSchema {
	const command = manifest.commands.find((entry) => entry.id === id);
	if (!command) {
		throw new Error(`command ${id} not in manifest`);
	}
	return command;
}

/** Every leaf verb the CLI exposes (groups like `task`/`db connection` are navigational). */
const EXPECTED_COMMAND_IDS = [
	"task.list",
	"task.show",
	"task.create",
	"task.update",
	"task.done",
	"task.trash",
	"task.delete",
	"task.link",
	"task.unlink",
	"task.start",
	"db.connection.list",
	"db.connection.add",
	"db.connection.remove",
	"db.connection.test",
	"db.tables",
	"db.describe",
	"db.browse",
	"db.query",
	"storage.connection.list",
	"storage.list",
	"storage.read",
	"file.list",
	"file.show",
	"file.add",
	"file.update",
	"file.delete",
	"file.path",
	"file.bytes",
	"vault.type.list",
	"vault.type.show",
	"vault.doc.list",
	"vault.doc.show",
	"vault.doc.create",
	"vault.doc.update",
	"vault.doc.delete",
	"home-thread.set-title",
	"home-thread.suggest-next",
	"service.install",
	"service.uninstall",
	"service.start",
	"service.stop",
	"service.restart",
	"service.status",
	"hooks.ingest",
	"hooks.notify",
	"hooks.gemini-hook",
	"hooks.codex-hook",
	"hooks.cleanup",
	"hooks.codex-wrapper",
	"remote.status",
	"remote.passcode.show",
	"remote.passcode.set",
	"remote.passcode.disable",
	"passcode",
	"schema",
];

describe("buildCliSchema — command coverage", () => {
	it("includes every leaf command and nothing else", () => {
		const manifest = buildRealManifest();
		const ids = manifest.commands.map((command) => command.id).sort();
		expect(ids).toEqual([...EXPECTED_COMMAND_IDS].sort());
	});

	it("derives each command id from its path", () => {
		const manifest = buildRealManifest();
		for (const command of manifest.commands) {
			expect(command.id).toBe(command.path.join("."));
		}
	});

	it("excludes navigational group commands (no `task` / `db.connection` bare group)", () => {
		const manifest = buildRealManifest();
		const ids = manifest.commands.map((command) => command.id);
		expect(ids).not.toContain("task");
		expect(ids).not.toContain("db");
		expect(ids).not.toContain("db.connection");
		expect(ids).not.toContain("vault.doc");
	});

	it("carries the schema + version envelope and the named schema registry", () => {
		const manifest = buildRealManifest();
		expect(manifest.schemaVersion).toBe(CLI_SCHEMA_VERSION);
		expect(manifest.kanbanVersion).toBe("9.9.9-test");
		expect(manifest.schemas).toHaveProperty("Task");
		expect(manifest.schemas).toHaveProperty("Generic");
	});

	it("resolves every command output ref to a defined schema", () => {
		const manifest = buildRealManifest();
		for (const command of manifest.commands) {
			const ref = command.output.ref.replace("#/schemas/", "");
			expect(manifest.schemas, `output ref for ${command.id}`).toHaveProperty(ref);
		}
	});
});

describe("buildCliSchema — option & positional shapes", () => {
	it("marks required vs optional options correctly", () => {
		const manifest = buildRealManifest();
		const create = commandById(manifest, "task.create");
		const prompt = create.options.find((option) => option.name === "prompt");
		const title = create.options.find((option) => option.name === "title");
		expect(prompt?.required).toBe(true);
		expect(title?.required).toBe(false);
	});

	it("infers value vs boolean option types", () => {
		const manifest = buildRealManifest();
		// A boolean global flag (no argument) is `boolean`; a value-taking flag is `string`.
		const json = manifest.globalOptions.find((option) => option.name === "json");
		expect(json?.type).toBe("boolean");
		const projectPath = manifest.globalOptions.find((option) => option.name === "project-path");
		expect(projectPath?.type).toBe("string");

		const https = commandById(manifest, "service.install").options.find((option) => option.name === "https");
		expect(https?.type).toBe("boolean");
		const create = commandById(manifest, "task.create");
		expect(create.options.find((option) => option.name === "prompt")?.type).toBe("string");
	});

	it("captures positionals with required/variadic flags", () => {
		const manifest = buildRealManifest();
		const describe_ = commandById(manifest, "db.describe");
		expect(describe_.positionals).toEqual([
			expect.objectContaining({ name: "table", required: true, variadic: false }),
		]);

		const wrapper = commandById(manifest, "hooks.codex-wrapper");
		const variadic = wrapper.positionals.find((positional) => positional.variadic);
		expect(variadic?.variadic).toBe(true);
		expect(variadic?.required).toBe(false);
	});

	it("preserves command aliases and flags hooks as internal", () => {
		const manifest = buildRealManifest();
		// `task done` / `task trash` are two distinct commands (trash is the deprecated one), not a
		// commander alias pair; the short alias that survives on a leaf verb is `db connection rm`.
		expect(commandById(manifest, "db.connection.remove").aliases).toEqual(["rm"]);
		expect(commandById(manifest, "hooks.ingest").internal).toBe(true);
		// Non-hooks commands are not internal.
		expect(commandById(manifest, "task.list").internal).toBeUndefined();
	});

	it("excludes hidden options from the manifest", () => {
		// The deprecated root `--agent` that motivated this filter was removed in P6, so assert
		// the behavior with a synthetic hidden global option: visible options are emitted, hidden
		// ones are not (an agent should never plan against an internal/no-op flag).
		const program = new Command().name("kanban").option("--project-path <path>", "Workspace to operate on.");
		program.addOption(new Option("--secret-internal <v>", "Hidden internal flag.").hideHelp());
		const manifest = buildCliSchema(program, { kanbanVersion: "0.0.0" });
		const names = manifest.globalOptions.map((option) => option.name);
		expect(names).toContain("project-path");
		expect(names).not.toContain("secret-internal");
	});

	it("records a negated boolean flag", () => {
		const manifest = buildRealManifest();
		const noPasscode = commandById(manifest, "service.install").options.find(
			(option) => option.name === "no-passcode",
		);
		expect(noPasscode?.negated).toBe(true);
		expect(noPasscode?.type).toBe("boolean");
	});
});

describe("buildCliSchema — enum extraction (single-source via commander .choices())", () => {
	it("reports type=enum with the choice list for an option declared via .choices()", () => {
		const program = new Command().name("kanban");
		program
			.command("paint")
			.addOption(new Option("--color <c>", "Pick a color.").choices(["red", "green", "blue"]))
			.addOption(new Option("--shade <s>", "Free text.").default(undefined))
			.action(() => {});
		const manifest = buildCliSchema(program, { kanbanVersion: "0.0.0" });
		const paint = commandById(manifest, "paint");
		const color = paint.options.find((option) => option.name === "color");
		expect(color?.type).toBe("enum");
		expect(color?.values).toEqual(["red", "green", "blue"]);
		const shade = paint.options.find((option) => option.name === "shade");
		expect(shade?.type).toBe("string");
		expect(shade?.values).toBeUndefined();
	});

	it("reports enum values for a positional declared via .choices()", () => {
		const program = new Command().name("kanban");
		program
			.command("pick")
			.addArgument(new Argument("<fruit>", "Which fruit.").choices(["apple", "pear"]))
			.action(() => {});
		const manifest = buildCliSchema(program, { kanbanVersion: "0.0.0" });
		const fruit = commandById(manifest, "pick").positionals[0];
		expect(fruit?.values).toEqual(["apple", "pear"]);
	});
});

describe("buildCliSchema — error codes & exit mapping", () => {
	it("enumerates every error code with the §6.2 exit mapping", () => {
		const manifest = buildRealManifest();
		const codes = manifest.errorCodes.map((entry) => entry.code).sort();
		expect(codes).toEqual([...CLI_ERROR_CODES].sort());
		for (const entry of manifest.errorCodes) {
			expect(entry.exitCode).toBe(exitCodeForErrorCode(entry.code));
		}
	});

	it("maps the not-found / unreachable / conflict families to their documented exits", () => {
		const manifest = buildRealManifest();
		const exitFor = (code: string) => manifest.errorCodes.find((entry) => entry.code === code)?.exitCode;
		expect(exitFor("task_not_found")).toBe(3);
		expect(exitFor("file_not_found")).toBe(3);
		expect(exitFor("document_not_found")).toBe(3);
		expect(exitFor("connection_not_found")).toBe(3);
		expect(exitFor("workspace_not_found")).toBe(3);
		expect(exitFor("runtime_unreachable")).toBe(4);
		expect(exitFor("dependency_cycle")).toBe(5);
		expect(exitFor("write_not_allowed")).toBe(5);
		expect(exitFor("internal_error")).toBe(1);
	});

	it("only references error codes that exist in the enum", () => {
		const manifest = buildRealManifest();
		const known = new Set<string>(CLI_ERROR_CODES);
		for (const command of manifest.commands) {
			for (const code of command.errors) {
				expect(known.has(code), `${command.id} → ${code}`).toBe(true);
			}
		}
	});
});

describe("narrowCliSchema", () => {
	it("narrows to a single command while keeping shared context", () => {
		const manifest = buildRealManifest();
		const narrowed = narrowCliSchema(manifest, "task.create");
		expect(narrowed.commands).toHaveLength(1);
		expect(narrowed.commands[0]?.id).toBe("task.create");
		expect(narrowed.schemas).toBe(manifest.schemas);
		expect(narrowed.errorCodes).toEqual(manifest.errorCodes);
	});

	it("throws a structured invalid_argument error for an unknown id", () => {
		const manifest = buildRealManifest();
		expect(() => narrowCliSchema(manifest, "task.nope")).toThrowError(CliError);
		try {
			narrowCliSchema(manifest, "task.nope");
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).code).toBe("invalid_argument");
			expect((error as CliError).details?.commandId).toBe("task.nope");
		}
	});
});

describe("manifest is a single JSON document", () => {
	it("round-trips through JSON.parse(JSON.stringify(...))", () => {
		const manifest = buildRealManifest();
		const reparsed = JSON.parse(JSON.stringify(manifest)) as CliSchemaManifest;
		expect(reparsed.commands.map((command) => command.id).sort()).toEqual(
			manifest.commands.map((command) => command.id).sort(),
		);
	});
});
