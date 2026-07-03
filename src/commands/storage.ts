import type { Command } from "commander";

import type { RuntimeVaultSettings } from "../core/api-contract";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";
import { CliError } from "./cli-envelope";
import {
	createRuntimeTrpcClient,
	ensureRuntimeWorkspace,
	type JsonRecord,
	resolveWorkspaceRepoPath,
} from "./runtime-workspace";

/**
 * Enforce the per-workspace agent-storage-access gate
 * (`RuntimeVaultSettings.agentStorageAccessEnabled`). When the switch is off the whole
 * `storage` channel is refused up front with a clear, structured error — the peer of the
 * `database_access_disabled` gate. Pure and side-effect-free so the gate is unit-testable
 * without a live runtime.
 */
export function assertStorageAccessEnabled(settings: Pick<RuntimeVaultSettings, "agentStorageAccessEnabled">): void {
	if (!settings.agentStorageAccessEnabled) {
		throw new CliError(
			"storage_access_disabled",
			"Agent storage access is disabled for this workspace. An operator can enable it in the " +
				"Storage view. The CLI storage channel is read-only.",
		);
	}
}

/**
 * Resolve the workspace and register it with the runtime so its scope header is recognized.
 *
 * This is the single chokepoint every `storage` subcommand passes through, so it also enforces
 * the per-workspace agent-storage-access gate via {@link assertStorageAccessEnabled}. The CLI
 * storage path is read-only by design (`StorageService` exposes no write/delete/presign), so
 * "may the agent touch storage at all" is the only question. The human Storage UI uses a
 * separate tRPC path and is unaffected.
 */
async function resolveStorageWorkspace(
	projectPath: string | undefined,
	cwd: string,
): Promise<{ repoPath: string; client: ReturnType<typeof createRuntimeTrpcClient> }> {
	const repoPath = await resolveWorkspaceRepoPath(projectPath, cwd);
	const workspaceId = await ensureRuntimeWorkspace(repoPath);
	const client = createRuntimeTrpcClient(workspaceId);
	const { settings } = await client.workspace.getVaultSettings.query();
	assertStorageAccessEnabled(settings);
	return { repoPath, client };
}

async function listConnections(input: { cwd: string; projectPath?: string }): Promise<JsonRecord> {
	const { repoPath, client } = await resolveStorageWorkspace(input.projectPath, input.cwd);
	const result = await client.storage.listConnections.query();
	return {
		ok: true,
		workspacePath: repoPath,
		connections: result.connections,
		count: result.connections.length,
	};
}

async function listObjects(input: {
	cwd: string;
	projectPath?: string;
	connId: string;
	prefix?: string;
	cursor?: string;
}): Promise<JsonRecord> {
	const { repoPath, client } = await resolveStorageWorkspace(input.projectPath, input.cwd);
	const result = await client.storage.listObjects.query({
		connId: input.connId,
		...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
		...(input.cursor !== undefined ? { continuationToken: input.cursor } : {}),
	});
	return {
		ok: true,
		workspacePath: repoPath,
		connId: input.connId,
		prefix: result.prefix,
		entries: result.entries,
		count: result.entries.length,
		isTruncated: result.isTruncated,
		...(result.nextContinuationToken !== undefined ? { nextCursor: result.nextContinuationToken } : {}),
	};
}

async function readObject(input: {
	cwd: string;
	projectPath?: string;
	connId: string;
	key: string;
}): Promise<JsonRecord> {
	const { repoPath, client } = await resolveStorageWorkspace(input.projectPath, input.cwd);
	const result = await client.storage.readObject.query({ connId: input.connId, key: input.key });
	return { ok: true, workspacePath: repoPath, connId: input.connId, object: result };
}

export function registerStorageCommand(program: Command): void {
	const storage = program
		.command("storage")
		.description("Browse S3 object-storage connections and objects from the CLI (read-only).");

	const connection = storage
		.command("connection")
		.alias("conn")
		.description("Inspect the workspace storage connection registry.");

	connection
		.command("list")
		.description("List storage connections registered for a workspace (secrets are never emitted).")
		.action(async function (this: Command) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"storage.connection.list",
				async () => await listConnections({ cwd: process.cwd(), projectPath: globals.projectPath }),
				{ globals },
			);
		});

	storage
		.command("list")
		.description(
			"List objects and sub-prefixes one level under a prefix (delimiter-scoped). " +
				"Use --cursor with a prior page's nextCursor to page through a truncated listing.",
		)
		.requiredOption("--connection <id>", "Storage connection id.")
		.option("--prefix <prefix>", "Key prefix to list under (defaults to the bucket root).")
		.option("--cursor <token>", "Opaque continuation token returned as nextCursor by a prior list.")
		.action(async function (this: Command, options: { connection: string; prefix?: string; cursor?: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"storage.list",
				async () =>
					await listObjects({
						cwd: process.cwd(),
						projectPath: globals.projectPath,
						connId: options.connection,
						prefix: options.prefix,
						cursor: options.cursor,
					}),
				{ globals },
			);
		});

	storage
		.command("read")
		.argument("<key>", "Object key to read.")
		.description(
			"Read a single object. Text is returned inline; binary is base64-encoded. An object that " +
				"exceeds the read cap returns tooLarge=true rather than being fully downloaded.",
		)
		.requiredOption("--connection <id>", "Storage connection id.")
		.action(async function (this: Command, key: string, options: { connection: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"storage.read",
				async () =>
					await readObject({
						cwd: process.cwd(),
						projectPath: globals.projectPath,
						connId: options.connection,
						key,
					}),
				{ globals },
			);
		});
}
