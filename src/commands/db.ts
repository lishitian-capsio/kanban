import type { Command } from "commander";

import type { RuntimeDbConnectionAddRequest, RuntimeDbEngine, RuntimeDbSslConfig } from "../core/api-contract";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";
import { CliError, type CliWarning } from "./cli-envelope";
import { resolveRequiredId } from "./cli-positional-args";
import {
	createRuntimeTrpcClient,
	ensureRuntimeWorkspace,
	type JsonRecord,
	resolveWorkspaceRepoPath,
} from "./runtime-workspace";

const VALID_ENGINES: readonly RuntimeDbEngine[] = ["postgres", "mysql", "sqlite", "redis"];
const VALID_SSL_MODES: ReadonlyArray<RuntimeDbSslConfig["mode"]> = ["disable", "require", "verify-ca", "verify-full"];

function parseEngine(value: string): RuntimeDbEngine {
	const normalized = value.trim().toLowerCase();
	if ((VALID_ENGINES as readonly string[]).includes(normalized)) {
		return normalized as RuntimeDbEngine;
	}
	throw new Error(`Invalid --engine "${value}". Expected one of: ${VALID_ENGINES.join(", ")}.`);
}

function parsePort(value: string): number {
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error(`Invalid --port "${value}". Expected a positive integer.`);
	}
	return port;
}

/**
 * Normalize the database `--port` for `db connection add`.
 *
 * The program-level global `--port <number|auto>` (parsed by `parseCliPortOption`) shadows
 * this command's own `--port` — commander routes a re-declared option to the ancestor that
 * also declares it (AGENTS.md), so the value reaches the action as a `RuntimePortOption`
 * union via `optsWithGlobals()` rather than this command's plain `number`. Collapse it back
 * to a numeric port; `auto` is meaningless for a database connection and is rejected.
 */
function resolveDbConnectionPort(raw: unknown): number | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}
	if (typeof raw === "number") {
		return raw;
	}
	if (typeof raw === "object" && "mode" in (raw as Record<string, unknown>)) {
		const option = raw as { mode: string; value?: number };
		if (option.mode === "fixed" && typeof option.value === "number") {
			return option.value;
		}
		throw new CliError("invalid_argument", "`--port auto` is not a valid database port; pass a numeric port.");
	}
	return undefined;
}

function parseSslMode(value: string): RuntimeDbSslConfig["mode"] {
	const normalized = value.trim().toLowerCase();
	if ((VALID_SSL_MODES as readonly string[]).includes(normalized)) {
		return normalized as RuntimeDbSslConfig["mode"];
	}
	throw new Error(`Invalid --ssl-mode "${value}". Expected one of: ${VALID_SSL_MODES.join(", ")}.`);
}

function parseBooleanFlag(value: unknown, flagName: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === true || value === false) {
		return value;
	}
	if (typeof value !== "string") {
		throw new Error(`Invalid boolean value for ${flagName}. Use true or false.`);
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	throw new Error(`Invalid boolean value for ${flagName}: "${value}". Use true or false.`);
}

/**
 * Resolve the workspace and register it with the runtime so its scope header is recognized.
 *
 * This is the single chokepoint every `db` subcommand passes through, so it also enforces the
 * per-workspace agent-database-access gate (`RuntimeVaultSettings.agentDatabaseAccessEnabled`):
 * when the switch is off the whole `db` channel is refused up front with a clear, structured
 * error, before any connection is read or query is run. The gate is deliberately the only state
 * consulted — the CLI path is read-only by design, so "may the agent touch the database at all"
 * is the only question. The human Database UI uses a separate tRPC router and is unaffected.
 */
async function resolveDbWorkspace(
	projectPath: string | undefined,
	cwd: string,
): Promise<{ repoPath: string; client: ReturnType<typeof createRuntimeTrpcClient> }> {
	const repoPath = await resolveWorkspaceRepoPath(projectPath, cwd);
	const workspaceId = await ensureRuntimeWorkspace(repoPath);
	const client = createRuntimeTrpcClient(workspaceId);
	const { settings } = await client.workspace.getVaultSettings.query();
	if (!settings.agentDatabaseAccessEnabled) {
		throw new CliError(
			"database_access_disabled",
			"Agent database access is disabled for this workspace. An operator can enable it in the " +
				"Database view (the “Allow agents to query via the kanban db CLI” switch). The CLI database channel is read-only.",
		);
	}
	return { repoPath, client };
}

async function listConnections(input: { cwd: string; projectPath?: string }): Promise<JsonRecord> {
	const { repoPath, client } = await resolveDbWorkspace(input.projectPath, input.cwd);
	const result = await client.db.connection.list.query();
	return {
		ok: true,
		workspacePath: repoPath,
		connections: result.connections,
		count: result.connections.length,
	};
}

function buildSslConfig(input: { sslMode?: string; sslCa?: string }): RuntimeDbSslConfig | undefined {
	if (input.sslMode === undefined) {
		return undefined;
	}
	const mode = parseSslMode(input.sslMode);
	const caPath = input.sslCa?.trim();
	return { mode, ...(caPath ? { caPath } : {}) };
}

async function addConnection(input: {
	cwd: string;
	projectPath?: string;
	id?: string;
	label: string;
	engine: RuntimeDbEngine;
	host?: string;
	port?: number;
	database?: string;
	user?: string;
	filePath?: string;
	ssl?: RuntimeDbSslConfig;
	allowWrites?: boolean;
	password?: string;
	sslKeyPem?: string;
	sslCertPem?: string;
}): Promise<JsonRecord> {
	const { repoPath, client } = await resolveDbWorkspace(input.projectPath, input.cwd);
	const request: RuntimeDbConnectionAddRequest = {
		...(input.id ? { connId: input.id } : {}),
		label: input.label,
		engine: input.engine,
		...(input.host !== undefined ? { host: input.host } : {}),
		...(input.port !== undefined ? { port: input.port } : {}),
		...(input.database !== undefined ? { database: input.database } : {}),
		...(input.user !== undefined ? { user: input.user } : {}),
		...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
		...(input.ssl !== undefined ? { ssl: input.ssl } : {}),
		...(input.allowWrites !== undefined ? { allowWrites: input.allowWrites } : {}),
		...(input.password !== undefined ? { password: input.password } : {}),
		...(input.sslKeyPem !== undefined ? { sslKeyPem: input.sslKeyPem } : {}),
		...(input.sslCertPem !== undefined ? { sslCertPem: input.sslCertPem } : {}),
	};
	const result = await client.db.connection.add.mutate(request);
	return { ok: true, workspacePath: repoPath, connection: result.connection };
}

async function removeConnection(input: { cwd: string; projectPath?: string; connId: string }): Promise<JsonRecord> {
	const { repoPath, client } = await resolveDbWorkspace(input.projectPath, input.cwd);
	const result = await client.db.connection.remove.mutate({ connId: input.connId });
	return { ok: true, workspacePath: repoPath, connId: result.connId, removed: result.removed };
}

async function testConnection(input: { cwd: string; projectPath?: string; connId: string }): Promise<JsonRecord> {
	const { repoPath, client } = await resolveDbWorkspace(input.projectPath, input.cwd);
	const result = await client.db.connection.test.mutate({ connId: input.connId });
	return {
		ok: true,
		workspacePath: repoPath,
		connId: result.connId,
		reachable: result.reachable,
		latencyMs: result.latencyMs,
		serverVersion: result.serverVersion,
		...(result.error ? { error: result.error } : {}),
	};
}

async function listTables(input: {
	cwd: string;
	projectPath?: string;
	connId: string;
	schema?: string;
}): Promise<JsonRecord> {
	const { repoPath, client } = await resolveDbWorkspace(input.projectPath, input.cwd);
	const result = await client.db.tables.query({
		connId: input.connId,
		...(input.schema !== undefined ? { schema: input.schema } : {}),
	});
	return {
		ok: true,
		workspacePath: repoPath,
		connId: result.connId,
		engine: result.engine,
		tables: result.tables,
		count: result.tables.length,
	};
}

async function describeTable(input: {
	cwd: string;
	projectPath?: string;
	connId: string;
	table: string;
	schema?: string;
}): Promise<JsonRecord> {
	const { repoPath, client } = await resolveDbWorkspace(input.projectPath, input.cwd);
	const result = await client.db.describe.query({
		connId: input.connId,
		table: input.table,
		...(input.schema !== undefined ? { schema: input.schema } : {}),
	});
	if (!result.table) {
		throw new Error(`Table "${input.table}" was not found on connection "${input.connId}".`);
	}
	return {
		ok: true,
		workspacePath: repoPath,
		connId: result.connId,
		engine: result.engine,
		table: result.table,
	};
}

async function browseTable(input: {
	cwd: string;
	projectPath?: string;
	connId: string;
	table: string;
	schema: string;
	pageSize?: number;
	cursor?: string;
}): Promise<JsonRecord> {
	const { repoPath, client } = await resolveDbWorkspace(input.projectPath, input.cwd);
	const result = await client.db.browse.mutate({
		connId: input.connId,
		schema: input.schema,
		table: input.table,
		...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
		...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
	});
	return { ok: true, workspacePath: repoPath, ...result };
}

async function runQuery(input: {
	cwd: string;
	projectPath?: string;
	connId: string;
	sql: string;
	pageSize?: number;
	cursor?: string;
}): Promise<JsonRecord> {
	const { repoPath, client } = await resolveDbWorkspace(input.projectPath, input.cwd);
	const result = await client.db.query.mutate({
		connId: input.connId,
		sql: input.sql,
		...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
		...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
	});
	return { ok: true, workspacePath: repoPath, ...result };
}

export function registerDbCommand(program: Command): void {
	const db = program.command("db").description("Manage database connections and run queries from the CLI.");

	const connection = db
		.command("connection")
		.alias("conn")
		.description("Manage the workspace database connection registry.");

	connection
		.command("list")
		.description("List database connections registered for a workspace.")
		.action(async function (this: Command) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"db.connection.list",
				async () => await listConnections({ cwd: process.cwd(), projectPath: globals.projectPath }),
				{ globals },
			);
		});

	connection
		.command("add")
		.description("Register a database connection. Secrets are stored machine-locally, never committed.")
		.requiredOption("--label <text>", "Human-readable connection label.")
		.requiredOption("--engine <engine>", "Database engine: postgres | mysql | sqlite | redis.", parseEngine)
		.option("--id <id>", "Explicit connection id. Defaults to a slug of the label.")
		.option("--host <host>", "Database host.")
		.option("--port <port>", "Database port.", parsePort)
		.option("--database <name>", "Database name.")
		.option("--user <user>", "Database user.")
		.option("--file-path <path>", "SQLite database file path.")
		.option("--ssl-mode <mode>", "SSL mode: disable | require | verify-ca | verify-full.")
		.option("--ssl-ca <path>", "Path to the CA certificate (used with --ssl-mode).")
		.option("--allow-writes [value]", "Allow writes on this connection (true|false). Flag-only implies true.")
		.option("--password <secret>", "Connection password (stored machine-locally, never committed).")
		.option("--ssl-key-pem <pem>", "Client SSL key PEM (stored machine-locally, never committed).")
		.option("--ssl-cert-pem <pem>", "Client SSL cert PEM (stored machine-locally, never committed).")
		.action(async function (
			this: Command,
			options: {
				label: string;
				engine: RuntimeDbEngine;
				id?: string;
				database?: string;
				user?: string;
				filePath?: string;
				sslMode?: string;
				sslCa?: string;
				allowWrites?: unknown;
				password?: string;
				sslKeyPem?: string;
				sslCertPem?: string;
			},
		) {
			const globals = readGlobalCliOptions(this);
			// `--host`/`--port` here are the DATABASE host/port. They collide with the
			// program-level runtime globals of the same name, so commander routes them to
			// the globals — read both from the merged view (port normalized back to a number).
			const merged = this.optsWithGlobals() as { host?: string; port?: unknown };
			await runCliCommand(
				"db.connection.add",
				async () =>
					await addConnection({
						cwd: process.cwd(),
						projectPath: globals.projectPath,
						id: options.id,
						label: options.label,
						engine: options.engine,
						host: merged.host,
						port: resolveDbConnectionPort(merged.port),
						database: options.database,
						user: options.user,
						filePath: options.filePath,
						ssl: buildSslConfig({ sslMode: options.sslMode, sslCa: options.sslCa }),
						allowWrites: parseBooleanFlag(options.allowWrites, "--allow-writes"),
						password: options.password,
						sslKeyPem: options.sslKeyPem,
						sslCertPem: options.sslCertPem,
					}),
				{ globals },
			);
		});

	connection
		.command("remove")
		.alias("rm")
		.description("Remove a database connection and delete its machine-local secret.")
		.argument("[id]", "Connection id to remove (positional, preferred over --connection).")
		.option("--connection <id>", "Deprecated: pass the connection id as the positional <id> instead.")
		.action(async function (this: Command, idArg: string | undefined, options: { connection?: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"db.connection.remove",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.connection,
						legacyFlagName: "--connection",
						missingMessage:
							"db connection remove requires a connection id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await removeConnection({
						cwd: process.cwd(),
						projectPath: globals.projectPath,
						connId: resolved.id,
					});
				},
				{ globals, warnings },
			);
		});

	connection
		.command("test")
		.description("Test connectivity for a registered database connection.")
		.argument("[id]", "Connection id to test (positional, preferred over --connection).")
		.option("--connection <id>", "Deprecated: pass the connection id as the positional <id> instead.")
		.action(async function (this: Command, idArg: string | undefined, options: { connection?: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"db.connection.test",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.connection,
						legacyFlagName: "--connection",
						missingMessage:
							"db connection test requires a connection id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await testConnection({
						cwd: process.cwd(),
						projectPath: globals.projectPath,
						connId: resolved.id,
					});
				},
				{ globals, warnings },
			);
		});

	db.command("tables")
		.description("List tables/views for a connection (schema introspection).")
		.requiredOption("--connection <id>", "Connection id.")
		.option("--schema <schema>", "Filter to a single schema (case-insensitive).")
		.action(async function (this: Command, options: { connection: string; schema?: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"db.tables",
				async () =>
					await listTables({
						cwd: process.cwd(),
						projectPath: globals.projectPath,
						connId: options.connection,
						schema: options.schema,
					}),
				{ globals },
			);
		});

	db.command("describe")
		.argument("<table>", "Table or view name to describe.")
		.description("Show the column structure of a table/view.")
		.requiredOption("--connection <id>", "Connection id.")
		.option("--schema <schema>", "Schema qualifier (case-insensitive).")
		.action(async function (this: Command, table: string, options: { connection: string; schema?: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"db.describe",
				async () =>
					await describeTable({
						cwd: process.cwd(),
						projectPath: globals.projectPath,
						connId: options.connection,
						table,
						schema: options.schema,
					}),
				{ globals },
			);
		});

	db.command("browse")
		.argument("<table>", "Table or view to browse.")
		.description(
			"Browse a table page-by-page with keyset (seek) pagination — flat latency at any depth, " +
				"unlike OFFSET. Falls back to OFFSET for a table with no primary key.",
		)
		.requiredOption("--connection <id>", "Connection id.")
		.requiredOption("--schema <schema>", "Schema/namespace the table lives in.")
		.option("--page-size <n>", "Rows per page (clamped by the core row cap).", parsePort)
		.option("--cursor <token>", "Opaque next-page cursor returned by a prior browse.")
		.action(async function (
			this: Command,
			table: string,
			options: { connection: string; schema: string; pageSize?: number; cursor?: string },
		) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"db.browse",
				async () =>
					await browseTable({
						cwd: process.cwd(),
						projectPath: globals.projectPath,
						connId: options.connection,
						table,
						schema: options.schema,
						pageSize: options.pageSize,
						cursor: options.cursor,
					}),
				{ globals },
			);
		});

	db.command("query")
		.argument("<sql>", "SQL statement to execute.")
		.description(
			"Run a read-only query. SQL engines: a single SELECT. Redis: a single read-only command " +
				"(e.g. \"HGETALL user:1\"). Writes/DDL are refused even on an allowWrites connection.",
		)
		.requiredOption("--connection <id>", "Connection id.")
		.option("--page-size <n>", "Rows per page for reads (clamped by the core row cap).", parsePort)
		.option("--cursor <token>", "Opaque next-page cursor returned by a prior query.")
		.action(async function (
			this: Command,
			sql: string,
			options: { connection: string; pageSize?: number; cursor?: string },
		) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"db.query",
				async () =>
					await runQuery({
						cwd: process.cwd(),
						projectPath: globals.projectPath,
						connId: options.connection,
						sql,
						pageSize: options.pageSize,
						cursor: options.cursor,
					}),
				{ globals },
			);
		});
}
