import { readFile } from "node:fs/promises";

import type { Command } from "commander";

import type { RuntimeFileCategory, RuntimeFileItem } from "../core/api-contract";
import { FileLibraryStore } from "../files/file-library-store";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";
import type { CliWarning } from "./cli-envelope";
import { resolveRequiredId } from "./cli-positional-args";
import { createRuntimeTrpcClient, type JsonRecord, resolveRuntimeWorkspace } from "./runtime-workspace";

const FILE_CATEGORIES = ["image", "document", "audio", "video", "archive", "text", "other"] as const;

function parseCategory(value: string | undefined): RuntimeFileCategory | undefined {
	if (value === undefined) {
		return undefined;
	}
	if ((FILE_CATEGORIES as readonly string[]).includes(value)) {
		return value as RuntimeFileCategory;
	}
	throw new Error(`Invalid category "${value}". Expected one of: ${FILE_CATEGORIES.join(", ")}.`);
}

function formatFileRecord(item: RuntimeFileItem): JsonRecord {
	return {
		id: item.id,
		name: item.name,
		mime: item.mime,
		category: item.category,
		size: item.size,
		addedAt: item.addedAt,
	};
}

// The file library lives on disk, so CLI commands operate on it directly without
// requiring a running runtime. After a mutation we best-effort notify the runtime
// (if one happens to be up) so any open UI refreshes; failures are ignored.
async function notifyRuntimeIfRunning(workspaceId: string): Promise<void> {
	try {
		await createRuntimeTrpcClient(workspaceId).workspace.notifyStateUpdated.mutate();
	} catch {
		// No runtime listening — the on-disk change is already durable.
	}
}

async function resolveStore(
	projectPath: string | undefined,
	cwd: string,
): Promise<{ store: FileLibraryStore; repoPath: string; workspaceId: string }> {
	// File library operations are pure on-disk work, so we register the workspace
	// locally if needed (no running runtime required) rather than erroring out.
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, { autoCreateIfMissing: true });
	return {
		store: new FileLibraryStore(workspace.repoPath),
		repoPath: workspace.repoPath,
		workspaceId: workspace.workspaceId,
	};
}

async function listFiles(input: {
	cwd: string;
	projectPath?: string;
	category?: RuntimeFileCategory;
}): Promise<JsonRecord> {
	const { store, repoPath } = await resolveStore(input.projectPath, input.cwd);
	const files = (await store.list())
		.filter((item) => (input.category ? item.category === input.category : true))
		.sort((left, right) => left.addedAt - right.addedAt)
		.map(formatFileRecord);
	return {
		ok: true,
		workspacePath: repoPath,
		category: input.category ?? null,
		files,
		count: files.length,
	};
}

async function showFile(input: { cwd: string; id: string; projectPath?: string }): Promise<JsonRecord> {
	const { store, repoPath } = await resolveStore(input.projectPath, input.cwd);
	const file = await store.get(input.id);
	if (!file) {
		throw new Error(`File "${input.id}" was not found in workspace ${repoPath}.`);
	}
	return { ok: true, workspacePath: repoPath, file: formatFileRecord(file) };
}

async function addFile(input: {
	cwd: string;
	path: string;
	name?: string;
	mime?: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const { store, repoPath, workspaceId } = await resolveStore(input.projectPath, input.cwd);
	const bytes = await readFile(input.path);
	const file = await store.add({ name: input.name ?? input.path, bytes, mime: input.mime });
	await notifyRuntimeIfRunning(workspaceId);
	return { ok: true, workspacePath: repoPath, file: formatFileRecord(file) };
}

async function updateFile(input: { cwd: string; id: string; name: string; projectPath?: string }): Promise<JsonRecord> {
	const { store, repoPath, workspaceId } = await resolveStore(input.projectPath, input.cwd);
	const file = await store.rename(input.id, input.name);
	await notifyRuntimeIfRunning(workspaceId);
	return { ok: true, workspacePath: repoPath, file: formatFileRecord(file) };
}

async function deleteFile(input: { cwd: string; id: string; projectPath?: string }): Promise<JsonRecord> {
	const { store, repoPath, workspaceId } = await resolveStore(input.projectPath, input.cwd);
	const deleted = await store.remove(input.id);
	if (!deleted) {
		throw new Error(`File "${input.id}" was not found in workspace ${repoPath}.`);
	}
	await notifyRuntimeIfRunning(workspaceId);
	return { ok: true, workspacePath: repoPath, id: input.id, deleted };
}

async function showFilePath(input: { cwd: string; id: string; projectPath?: string }): Promise<JsonRecord> {
	const { store, repoPath } = await resolveStore(input.projectPath, input.cwd);
	const result = await store.getPath(input.id);
	if (!result) {
		throw new Error(`File "${input.id}" was not found in workspace ${repoPath}.`);
	}
	return {
		ok: true,
		workspacePath: repoPath,
		file: formatFileRecord(result.item),
		absolutePath: result.absolutePath,
		relativePath: result.relativePath,
	};
}

async function showFileBytes(input: { cwd: string; id: string; projectPath?: string }): Promise<JsonRecord> {
	const { store, repoPath } = await resolveStore(input.projectPath, input.cwd);
	const result = await store.getBytes(input.id);
	if (!result) {
		throw new Error(`File "${input.id}" was not found in workspace ${repoPath}.`);
	}
	return {
		ok: true,
		workspacePath: repoPath,
		file: formatFileRecord(result.item),
		mimeType: result.mimeType,
		data: result.data,
	};
}

export function registerFileCommand(program: Command): void {
	const file = program
		.command("file")
		.alias("files")
		.description("Manage the Kanban file library (shared, git-committed reference files).");

	file
		.command("list")
		.description("List files in the library for a workspace.")
		.option("--category <category>", `Filter by category: ${FILE_CATEGORIES.join(" | ")}.`, parseCategory)
		.action(async function (this: Command, options: { category?: RuntimeFileCategory }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"file.list",
				async () =>
					await listFiles({ cwd: process.cwd(), projectPath: globals.projectPath, category: options.category }),
				{ globals },
			);
		});

	file
		.command("show")
		.description("Show a single file's metadata.")
		.argument("[id]", "File ID (positional, preferred over --id).")
		.option("--id <id>", "Deprecated: pass the file ID as the positional <id> instead.")
		.action(async function (this: Command, idArg: string | undefined, options: { id?: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"file.show",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.id,
						legacyFlagName: "--id",
						missingMessage: "file show requires a file id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await showFile({ cwd: process.cwd(), id: resolved.id, projectPath: globals.projectPath });
				},
				{ globals, warnings },
			);
		});

	file
		.command("add")
		.description("Add a local file to the library.")
		.argument("[path]", "Path to the local file to import (positional, preferred over --path).")
		.option("--path <path>", "Deprecated: pass the file path as the positional <path> instead.")
		.option("--name <name>", "Override the stored file name. Defaults to the source file's name.")
		.option("--mime <mime>", "Override the detected mime type.")
		.action(async function (
			this: Command,
			pathArg: string | undefined,
			options: { path?: string; name?: string; mime?: string },
		) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"file.add",
				async () => {
					const resolved = resolveRequiredId({
						positional: pathArg,
						legacyFlagValue: options.path,
						legacyFlagName: "--path",
						positionalLabel: "<path>",
						missingMessage: "file add requires a file path. Pass it as the positional <path> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await addFile({
						cwd: process.cwd(),
						path: resolved.id,
						name: options.name,
						mime: options.mime,
						projectPath: globals.projectPath,
					});
				},
				{ globals, warnings },
			);
		});

	file
		.command("update")
		.description("Rename a file in the library.")
		.argument("[id]", "File ID (positional, preferred over --id).")
		.option("--id <id>", "Deprecated: pass the file ID as the positional <id> instead.")
		.requiredOption("--name <name>", "New file name.")
		.action(async function (this: Command, idArg: string | undefined, options: { id?: string; name: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"file.update",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.id,
						legacyFlagName: "--id",
						missingMessage: "file update requires a file id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await updateFile({
						cwd: process.cwd(),
						id: resolved.id,
						name: options.name,
						projectPath: globals.projectPath,
					});
				},
				{ globals, warnings },
			);
		});

	file
		.command("delete")
		.description("Delete a file from the library.")
		.argument("[id]", "File ID (positional, preferred over --id).")
		.option("--id <id>", "Deprecated: pass the file ID as the positional <id> instead.")
		.action(async function (this: Command, idArg: string | undefined, options: { id?: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"file.delete",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.id,
						legacyFlagName: "--id",
						missingMessage: "file delete requires a file id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await deleteFile({ cwd: process.cwd(), id: resolved.id, projectPath: globals.projectPath });
				},
				{ globals, warnings },
			);
		});

	file
		.command("path")
		.description("Print a file's absolute and repo-relative paths (for agent @ references).")
		.argument("[id]", "File ID (positional, preferred over --id).")
		.option("--id <id>", "Deprecated: pass the file ID as the positional <id> instead.")
		.action(async function (this: Command, idArg: string | undefined, options: { id?: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"file.path",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.id,
						legacyFlagName: "--id",
						missingMessage: "file path requires a file id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await showFilePath({ cwd: process.cwd(), id: resolved.id, projectPath: globals.projectPath });
				},
				{ globals, warnings },
			);
		});

	file
		.command("bytes")
		.description("Print a file's content as base64 (for inline agent vision content).")
		.argument("[id]", "File ID (positional, preferred over --id).")
		.option("--id <id>", "Deprecated: pass the file ID as the positional <id> instead.")
		.action(async function (this: Command, idArg: string | undefined, options: { id?: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"file.bytes",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.id,
						legacyFlagName: "--id",
						missingMessage: "file bytes requires a file id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await showFileBytes({ cwd: process.cwd(), id: resolved.id, projectPath: globals.projectPath });
				},
				{ globals, warnings },
			);
		});
}
