/**
 * `kanban schema` — the machine-readable capability manifest (design doc §7.4, phase P3).
 *
 * This is the CLI analogue of an OpenAPI document: it lets an agent discover every command,
 * its positionals/options (with types, required-ness, and enum values), its output schema
 * reference, and its possible structured error codes — without scraping `--help` prose.
 *
 * The load-bearing property is **no drift**: the command tree, positionals, options, option
 * types, required flags, and enum `values` are all read back out of the live commander
 * definitions the CLI already holds (`Command.commands` / `.registeredArguments` /
 * `.options`). The only thing layered on top is a small, explicit per-command registry that
 * names the output schema and the error codes a handler can emit — facts commander does not
 * model. Because everything else is derived from commander at invocation time, the manifest
 * cannot describe a command/option shape that differs from what the parser actually accepts.
 *
 * This module performs NO I/O. The `schema` command action (registered here) runs the build
 * inside `runCliCommand`, so the manifest is emitted as the envelope `data` like every other
 * command (§4.2) — `kanban schema --json` is a single `JSON.parse`-able document.
 */

import type { Argument, Command, Option } from "commander";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";
import { CLI_ERROR_CODES, CLI_SCHEMA_VERSION, CliError, type CliErrorCode, exitCodeForErrorCode } from "./cli-envelope";

/** Whether an option/positional accepts a value, a closed set of values, or no value. */
export type CliSchemaValueType = "boolean" | "string" | "enum";

export interface CliOptionSchema {
	/** Long flag without the leading dashes, e.g. `--agent-id` → `"agent-id"`. */
	name: string;
	type: CliSchemaValueType;
	/** True when the option must be supplied (commander `requiredOption`). */
	required: boolean;
	description?: string;
	/** Present iff `type === "enum"` — the closed set commander validates against (`.choices()`). */
	values?: string[];
	/** True for a `--no-*` negated boolean flag. */
	negated?: boolean;
	default?: unknown;
}

export interface CliPositionalSchema {
	name: string;
	required: boolean;
	variadic: boolean;
	description?: string;
	values?: string[];
}

export interface CliCommandSchema {
	/** Canonical dotted id, matches the `command` field in every envelope (e.g. `"task.create"`). */
	id: string;
	/** The command path segments, e.g. `["task", "create"]`. */
	path: string[];
	summary: string;
	aliases?: string[];
	/** True for integration-only commands (the `hooks` family) hidden from the top-level summary. */
	internal?: boolean;
	positionals: CliPositionalSchema[];
	options: CliOptionSchema[];
	/** Reference into `schemas` describing the success `data` shape (§4.5). */
	output: { ref: string };
	/** The structured `error.code`s this command can emit (§6.3). */
	errors: CliErrorCode[];
}

export interface CliErrorCodeSchema {
	code: CliErrorCode;
	/** The process exit code this error maps to (§6.2). */
	exitCode: number;
}

export interface CliSchemaManifest {
	schemaVersion: string;
	kanbanVersion: string;
	/** Cross-cutting flags declared once on the root program and inherited by every command (§6.1). */
	globalOptions: CliOptionSchema[];
	commands: CliCommandSchema[];
	/** Named output-data schemas referenced by `command.output.ref` (illustrative field maps). */
	schemas: Record<string, unknown>;
	/** The §6.3 enum, each annotated with its §6.2 exit-code mapping. */
	errorCodes: CliErrorCodeSchema[];
}

/**
 * The per-command output-schema + error registry (the "small per-command registry" of §7.4).
 *
 * Keyed by the same dotted id commander produces, so a typo here is caught by the
 * "every command resolves to a known ref" unit test. Commands absent from the registry fall
 * back to {@link GENERIC_OUTPUT_REF} + {@link DEFAULT_WORKSPACE_ERRORS}.
 */
interface CommandSchemaMeta {
	output: { ref: string };
	errors: CliErrorCode[];
}

const GENERIC_OUTPUT_REF = "#/schemas/Generic";

/** Errors any workspace-scoped command can surface before it does anything else. */
const DEFAULT_WORKSPACE_ERRORS: CliErrorCode[] = ["workspace_not_found", "runtime_unreachable"];

const VALIDATION_ERRORS: CliErrorCode[] = [...DEFAULT_WORKSPACE_ERRORS, "validation_failed", "invalid_argument"];

const COMMAND_SCHEMA_REGISTRY: Record<string, CommandSchemaMeta> = {
	"task.list": { output: { ref: "#/schemas/TaskListResult" }, errors: DEFAULT_WORKSPACE_ERRORS },
	"task.create": { output: { ref: "#/schemas/TaskMutationResult" }, errors: VALIDATION_ERRORS },
	"task.update": {
		output: { ref: "#/schemas/TaskMutationResult" },
		errors: [...VALIDATION_ERRORS, "task_not_found"],
	},
	"task.start": {
		output: { ref: "#/schemas/TaskMutationResult" },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "task_not_found"],
	},
	"task.trash": {
		output: { ref: "#/schemas/TaskMutationResult" },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "task_not_found"],
	},
	"task.delete": {
		output: { ref: "#/schemas/TaskMutationResult" },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "task_not_found"],
	},
	"task.link": {
		output: { ref: "#/schemas/DependencyResult" },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "task_not_found", "dependency_cycle"],
	},
	"task.unlink": {
		output: { ref: "#/schemas/DependencyResult" },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "task_not_found"],
	},
	// Every `db` subcommand is gated by the per-workspace agent-database-access switch
	// (`RuntimeVaultSettings.agentDatabaseAccessEnabled`), so each can fail with
	// `database_access_disabled` before doing any work — see `resolveDbWorkspace` in `db.ts`.
	"db.connection.list": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "database_access_disabled"],
	},
	"db.connection.add": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...VALIDATION_ERRORS, "database_access_disabled"],
	},
	"db.connection.remove": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "connection_not_found", "database_access_disabled"],
	},
	"db.connection.test": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "connection_not_found", "database_access_disabled"],
	},
	"db.tables": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "connection_not_found", "database_access_disabled"],
	},
	"db.describe": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "connection_not_found", "database_access_disabled"],
	},
	"db.browse": {
		output: { ref: "#/schemas/DbRowsResult" },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "connection_not_found", "write_not_allowed", "database_access_disabled"],
	},
	"db.query": {
		output: { ref: "#/schemas/DbRowsResult" },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "connection_not_found", "write_not_allowed", "database_access_disabled"],
	},
	// Every `storage` subcommand is gated by the per-workspace agent-storage-access switch
	// (`RuntimeVaultSettings.agentStorageAccessEnabled`), so each can fail with
	// `storage_access_disabled` before doing any work — see `assertStorageAccessEnabled` in
	// `storage.ts`. The CLI storage channel is read-only (browse/read only, no write path).
	"storage.connection.list": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "storage_access_disabled"],
	},
	"storage.list": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "connection_not_found", "storage_access_disabled"],
	},
	"storage.read": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "connection_not_found", "storage_access_disabled"],
	},
	"file.list": { output: { ref: GENERIC_OUTPUT_REF }, errors: DEFAULT_WORKSPACE_ERRORS },
	"file.show": {
		output: { ref: "#/schemas/FileEntry" },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "file_not_found"],
	},
	"file.add": { output: { ref: "#/schemas/FileEntry" }, errors: VALIDATION_ERRORS },
	"file.update": {
		output: { ref: "#/schemas/FileEntry" },
		errors: [...VALIDATION_ERRORS, "file_not_found"],
	},
	"file.delete": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "file_not_found"],
	},
	"file.path": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "file_not_found"],
	},
	"file.bytes": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "file_not_found"],
	},
	"vault.type.list": { output: { ref: GENERIC_OUTPUT_REF }, errors: DEFAULT_WORKSPACE_ERRORS },
	"vault.type.show": {
		output: { ref: "#/schemas/VaultType" },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "document_not_found"],
	},
	"vault.doc.list": { output: { ref: GENERIC_OUTPUT_REF }, errors: DEFAULT_WORKSPACE_ERRORS },
	"vault.doc.show": {
		output: { ref: "#/schemas/VaultDoc" },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "document_not_found"],
	},
	"vault.doc.create": { output: { ref: "#/schemas/VaultDoc" }, errors: VALIDATION_ERRORS },
	"vault.doc.update": {
		output: { ref: "#/schemas/VaultDoc" },
		errors: [...VALIDATION_ERRORS, "document_not_found"],
	},
	"vault.doc.delete": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "document_not_found"],
	},
	// The typed-relation query channel is read-only (validate + traverse), so it surfaces no
	// write/mutation errors — only workspace resolution and (for traverse) an unknown start id.
	"vault.relations.check": { output: { ref: GENERIC_OUTPUT_REF }, errors: DEFAULT_WORKSPACE_ERRORS },
	"vault.relations.traverse": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "document_not_found"],
	},
	"home-thread.set-title": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "invalid_argument"],
	},
	"home-thread.suggest-next": {
		output: { ref: GENERIC_OUTPUT_REF },
		errors: [...DEFAULT_WORKSPACE_ERRORS, "invalid_argument"],
	},
	"service.install": {
		output: { ref: "#/schemas/ServiceActionResult" },
		errors: ["service_unsupported_platform", "invalid_argument", "internal_error"],
	},
	"service.uninstall": {
		output: { ref: "#/schemas/ServiceActionResult" },
		errors: ["service_unsupported_platform", "internal_error"],
	},
	"service.start": {
		output: { ref: "#/schemas/ServiceActionResult" },
		errors: ["service_unsupported_platform", "internal_error"],
	},
	"service.stop": {
		output: { ref: "#/schemas/ServiceActionResult" },
		errors: ["service_unsupported_platform", "internal_error"],
	},
	"service.restart": {
		output: { ref: "#/schemas/ServiceActionResult" },
		errors: ["service_unsupported_platform", "internal_error"],
	},
	"service.status": {
		output: { ref: "#/schemas/ServiceStatusResult" },
		errors: ["service_unsupported_platform", "internal_error"],
	},
	release: {
		output: { ref: "#/schemas/ReleaseResult" },
		errors: ["invalid_argument", "validation_failed", "internal_error"],
	},
	passcode: { output: { ref: GENERIC_OUTPUT_REF }, errors: ["passcode_not_set"] },
	schema: { output: { ref: "#/schemas/CliSchemaManifest" }, errors: ["invalid_argument"] },
	update: { output: { ref: GENERIC_OUTPUT_REF }, errors: ["internal_error"] },
};

/**
 * Named output-data schemas referenced by `command.output.ref` (§4.5). These are
 * illustrative field maps — the authoritative shape is always the envelope `data` a command
 * actually emits. They mirror the formatters in the command handlers (e.g. `formatTaskRecord`).
 */
const CLI_SCHEMAS: Record<string, unknown> = {
	Generic: {
		type: "object",
		description: "Command-specific success payload; see the command's `data` field.",
	},
	Task: {
		type: "object",
		fields: {
			id: "string",
			prompt: "string",
			column: "enum(backlog|in_progress|review|trash)",
			baseRef: "string",
			startInPlanMode: "boolean",
			autoReviewEnabled: "boolean",
			autoReviewMode: "enum(commit|pr)",
			agentId: "string?",
			owner: "object?",
			createdAt: "string",
			updatedAt: "string",
			session: "Session|null",
		},
	},
	Session: {
		type: "object",
		fields: {
			state: "string",
			agentId: "string",
			pid: "number|null",
			startedAt: "string",
			updatedAt: "string",
			lastOutputAt: "string|null",
			reviewReason: "string|null",
			exitCode: "number|null",
		},
	},
	Dependency: {
		type: "object",
		fields: {
			id: "string",
			backlogTaskId: "string",
			backlogTaskColumn: "string|null",
			linkedTaskId: "string",
			linkedTaskColumn: "string|null",
			createdAt: "string",
		},
	},
	TaskListResult: {
		type: "object",
		fields: {
			workspacePath: "string",
			column: "string|null",
			count: "number",
			tasks: "Task[]",
			dependencies: "Dependency[]",
		},
	},
	TaskMutationResult: {
		type: "object",
		fields: { workspacePath: "string", task: "Task" },
	},
	DependencyResult: {
		type: "object",
		fields: { workspacePath: "string", dependency: "Dependency" },
	},
	DbRowsResult: {
		type: "object",
		fields: { workspacePath: "string", rows: "object[]", cursor: "string|null" },
	},
	FileEntry: {
		type: "object",
		fields: { id: "string", name: "string", category: "string", mime: "string", size: "number" },
	},
	VaultType: {
		type: "object",
		fields: { type: "string", title: "string", body: "string" },
	},
	VaultDoc: {
		type: "object",
		fields: { id: "string", type: "string", title: "string", body: "string", frontmatter: "object" },
	},
	ServiceActionResult: {
		type: "object",
		fields: { action: "string", platform: "string", name: "string", message: "string" },
	},
	ServiceStatusResult: {
		type: "object",
		fields: { action: "string", platform: "string", name: "string", installed: "boolean", running: "boolean" },
	},
	ReleaseResult: {
		type: "object",
		fields: {
			dryRun: "boolean",
			previousVersion: "string",
			version: "string",
			bump: "enum(patch|minor|major|explicit)",
			tag: "string",
			branch: "string",
			remote: "string",
			commit: "string?",
			commitMessage: "string",
			pushed: "boolean",
			steps: "string[]",
			actionsRunUrl: "string|null",
			actionsUrl: "string|null",
		},
	},
	CliSchemaManifest: {
		type: "object",
		description: "This document — the recursive output of `kanban schema`.",
	},
};

function optionToSchema(option: Option): CliOptionSchema {
	const hasChoices = Array.isArray(option.argChoices) && option.argChoices.length > 0;
	// A `--no-*` flag (`option.negate`) takes no argument, so it is boolean like a plain flag;
	// commander's `isBoolean()` excludes negated options, hence the explicit `|| option.negate`.
	const type: CliSchemaValueType = option.isBoolean() || option.negate ? "boolean" : hasChoices ? "enum" : "string";
	return {
		name: option.name(),
		type,
		required: option.mandatory === true,
		...(option.description ? { description: option.description } : {}),
		...(hasChoices ? { values: [...(option.argChoices as string[])] } : {}),
		...(option.negate ? { negated: true } : {}),
		...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}),
	};
}

function argumentToSchema(argument: Argument): CliPositionalSchema {
	const hasChoices = Array.isArray(argument.argChoices) && argument.argChoices.length > 0;
	return {
		name: argument.name(),
		required: argument.required,
		variadic: argument.variadic,
		...(argument.description ? { description: argument.description } : {}),
		...(hasChoices ? { values: [...(argument.argChoices as string[])] } : {}),
	};
}

interface DiscoveredCommand {
	command: Command;
	path: string[];
	internal: boolean;
}

/**
 * Depth-first walk of the commander tree collecting executable **leaf** commands (those with
 * no subcommands). The root program and navigational group commands (`task`, `db`,
 * `db connection`, `vault`, `vault doc`, `service`, …) carry no action of their own and are
 * intentionally omitted — the manifest enumerates the verbs an agent can actually invoke.
 */
function collectLeafCommands(program: Command): DiscoveredCommand[] {
	const discovered: DiscoveredCommand[] = [];
	const walk = (command: Command, path: string[], internal: boolean): void => {
		for (const sub of command.commands) {
			const subPath = [...path, sub.name()];
			// The `hooks` family is integration wire-protocol surface (§6.4): keep it discoverable
			// but flag it so agents can filter it out of the user-facing command set.
			const subInternal = internal || sub.name() === "hooks";
			if (sub.commands.length === 0) {
				discovered.push({ command: sub, path: subPath, internal: subInternal });
			} else {
				walk(sub, subPath, subInternal);
			}
		}
	};
	walk(program, [], false);
	return discovered;
}

function commandToSchema({ command, path, internal }: DiscoveredCommand): CliCommandSchema {
	const id = path.join(".");
	const meta = COMMAND_SCHEMA_REGISTRY[id];
	const aliases = command.aliases();
	return {
		id,
		path,
		summary: command.description(),
		...(aliases.length > 0 ? { aliases } : {}),
		...(internal ? { internal: true } : {}),
		positionals: command.registeredArguments.map(argumentToSchema),
		// Hidden options are dropped from the manifest per §8 — an agent should not plan against
		// a no-op/internal flag. (The root `--agent` that motivated this filter was removed in P6.)
		options: command.options.filter((option) => !option.hidden).map(optionToSchema),
		output: meta?.output ?? { ref: GENERIC_OUTPUT_REF },
		errors: meta?.errors ?? DEFAULT_WORKSPACE_ERRORS,
	};
}

/**
 * Build the full capability manifest from a live commander program (§7.4). Pure — the caller
 * supplies the version so this stays free of `package.json` import side effects.
 */
export function buildCliSchema(program: Command, options: { kanbanVersion: string }): CliSchemaManifest {
	const commands = collectLeafCommands(program)
		.map(commandToSchema)
		.sort((a, b) => a.id.localeCompare(b.id));
	return {
		schemaVersion: CLI_SCHEMA_VERSION,
		kanbanVersion: options.kanbanVersion,
		globalOptions: program.options.filter((option) => !option.hidden).map(optionToSchema),
		commands,
		schemas: CLI_SCHEMAS,
		errorCodes: CLI_ERROR_CODES.map((code) => ({ code, exitCode: exitCodeForErrorCode(code) })),
	};
}

/**
 * Narrow a manifest to a single command id (`kanban schema task.create`). Keeps the shared
 * `schemas`/`errorCodes`/`globalOptions` context so the narrowed document is still
 * self-contained; throws {@link CliError} `invalid_argument` for an unknown id.
 */
export function narrowCliSchema(manifest: CliSchemaManifest, commandId: string): CliSchemaManifest {
	const match = manifest.commands.find((command) => command.id === commandId);
	if (!match) {
		throw new CliError("invalid_argument", `Unknown command id "${commandId}".`, {
			commandId,
			availableCommands: manifest.commands.map((command) => command.id),
		});
	}
	return { ...manifest, commands: [match] };
}

/** Climb to the root program so the manifest always reflects the entire tree. */
function rootProgram(command: Command): Command {
	let current = command;
	while (current.parent) {
		current = current.parent;
	}
	return current;
}

/**
 * Register `kanban schema [command]`. The manifest is emitted through `runCliCommand` like
 * every other command, so it lands in the envelope `data` and `kanban schema --json` is a
 * single `JSON.parse`-able document (§4.2 / §7.3). This command targets agents, so the auto
 * mode already defaults to JSON when piped; humans get the same payload pretty-printed.
 */
export function registerSchemaCommand(program: Command, options: { kanbanVersion: string }): void {
	program
		.command("schema [command]")
		.description("Emit the machine-readable CLI capability manifest as JSON. Pass a command id to narrow it.")
		.addHelpText(
			"after",
			[
				"",
				"Examples:",
				"  kanban schema --json            # full manifest (commands, schemas, errorCodes)",
				"  kanban schema task.create       # narrow to one command",
				"",
			].join("\n"),
		)
		.action(async function (this: Command, commandId: string | undefined) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"schema",
				async () => {
					const manifest = buildCliSchema(rootProgram(this), { kanbanVersion: options.kanbanVersion });
					const result = commandId ? narrowCliSchema(manifest, commandId) : manifest;
					return result as unknown as Record<string, unknown>;
				},
				{ globals },
			);
		});
}
