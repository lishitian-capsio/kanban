import type { Command } from "commander";

import type { RuntimeDbConnectionAddRequest, RuntimeDbEngine, RuntimeDbSslConfig } from "../core/api-contract";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import {
	createRuntimeTrpcClient,
	ensureRuntimeWorkspace,
	type JsonRecord,
	printJson,
	resolveWorkspaceRepoPath,
	toErrorMessage,
} from "./runtime-workspace";

const VALID_ENGINES: readonly RuntimeDbEngine[] = ["postgres", "mysql", "sqlite"];
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

/** Resolve the workspace and register it with the runtime so its scope header is recognized. */
async function resolveDbWorkspace(
	projectPath: string | undefined,
	cwd: string,
): Promise<{ repoPath: string; client: ReturnType<typeof createRuntimeTrpcClient> }> {
	const repoPath = await resolveWorkspaceRepoPath(projectPath, cwd);
	const workspaceId = await ensureRuntimeWorkspace(repoPath);
	return { repoPath, client: createRuntimeTrpcClient(workspaceId) };
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

async function runDbCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Database command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
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
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { projectPath?: string }) => {
			await runDbCommand(
				async () => await listConnections({ cwd: process.cwd(), projectPath: options.projectPath }),
			);
		});

	connection
		.command("add")
		.description("Register a database connection. Secrets are stored machine-locally, never committed.")
		.requiredOption("--label <text>", "Human-readable connection label.")
		.requiredOption("--engine <engine>", "Database engine: postgres | mysql | sqlite.", parseEngine)
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
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (options: {
				label: string;
				engine: RuntimeDbEngine;
				id?: string;
				host?: string;
				port?: number;
				database?: string;
				user?: string;
				filePath?: string;
				sslMode?: string;
				sslCa?: string;
				allowWrites?: unknown;
				password?: string;
				sslKeyPem?: string;
				sslCertPem?: string;
				projectPath?: string;
			}) => {
				await runDbCommand(
					async () =>
						await addConnection({
							cwd: process.cwd(),
							projectPath: options.projectPath,
							id: options.id,
							label: options.label,
							engine: options.engine,
							host: options.host,
							port: options.port,
							database: options.database,
							user: options.user,
							filePath: options.filePath,
							ssl: buildSslConfig({ sslMode: options.sslMode, sslCa: options.sslCa }),
							allowWrites: parseBooleanFlag(options.allowWrites, "--allow-writes"),
							password: options.password,
							sslKeyPem: options.sslKeyPem,
							sslCertPem: options.sslCertPem,
						}),
				);
			},
		);

	connection
		.command("remove")
		.alias("rm")
		.description("Remove a database connection and delete its machine-local secret.")
		.requiredOption("--connection <id>", "Connection id to remove.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { connection: string; projectPath?: string }) => {
			await runDbCommand(
				async () =>
					await removeConnection({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						connId: options.connection,
					}),
			);
		});

	connection
		.command("test")
		.description("Test connectivity for a registered database connection.")
		.requiredOption("--connection <id>", "Connection id to test.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { connection: string; projectPath?: string }) => {
			await runDbCommand(
				async () =>
					await testConnection({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						connId: options.connection,
					}),
			);
		});

	db.command("tables")
		.description("List tables/views for a connection (schema introspection).")
		.requiredOption("--connection <id>", "Connection id.")
		.option("--schema <schema>", "Filter to a single schema (case-insensitive).")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { connection: string; schema?: string; projectPath?: string }) => {
			await runDbCommand(
				async () =>
					await listTables({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						connId: options.connection,
						schema: options.schema,
					}),
			);
		});

	db.command("describe")
		.argument("<table>", "Table or view name to describe.")
		.description("Show the column structure of a table/view.")
		.requiredOption("--connection <id>", "Connection id.")
		.option("--schema <schema>", "Schema qualifier (case-insensitive).")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (table: string, options: { connection: string; schema?: string; projectPath?: string }) => {
			await runDbCommand(
				async () =>
					await describeTable({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						connId: options.connection,
						table,
						schema: options.schema,
					}),
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
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (
				table: string,
				options: { connection: string; schema: string; pageSize?: number; cursor?: string; projectPath?: string },
			) => {
				await runDbCommand(
					async () =>
						await browseTable({
							cwd: process.cwd(),
							projectPath: options.projectPath,
							connId: options.connection,
							table,
							schema: options.schema,
							pageSize: options.pageSize,
							cursor: options.cursor,
						}),
				);
			},
		);

	db.command("query")
		.argument("<sql>", "SQL statement to execute.")
		.description(
			"Run a SQL query. Reads are bounded by the core's default read-only policy, paging, and row/byte caps.",
		)
		.requiredOption("--connection <id>", "Connection id.")
		.option("--page-size <n>", "Rows per page for reads (clamped by the core row cap).", parsePort)
		.option("--cursor <token>", "Opaque next-page cursor returned by a prior query.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (
				sql: string,
				options: { connection: string; pageSize?: number; cursor?: string; projectPath?: string },
			) => {
				await runDbCommand(
					async () =>
						await runQuery({
							cwd: process.cwd(),
							projectPath: options.projectPath,
							connId: options.connection,
							sql,
							pageSize: options.pageSize,
							cursor: options.cursor,
						}),
				);
			},
		);
}
