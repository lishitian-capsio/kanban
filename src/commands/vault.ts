import { readFile } from "node:fs/promises";

import type { Command } from "commander";

import type { RuntimeVaultDocument, RuntimeVaultFrontmatterValue } from "../core/api-contract";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import { VaultDocumentStore } from "../vault/vault-document-store";
import {
	createRuntimeTrpcClient,
	type JsonRecord,
	printJson,
	resolveRuntimeWorkspace,
	toErrorMessage,
} from "./runtime-workspace";

function formatDocumentRecord(doc: RuntimeVaultDocument): JsonRecord {
	return {
		id: doc.id,
		type: doc.type,
		title: doc.title,
		body: doc.body,
		frontmatter: doc.frontmatter,
		relativePath: doc.relativePath,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
	};
}

/**
 * Parse repeatable `--set key=value` options into a frontmatter patch. Values
 * are kept as strings (the CLI surface is intentionally simple); richer typing
 * happens through the tRPC/web-ui path. A bare `--set key=` sets an empty string
 * (the store merges, so it never deletes a key).
 */
function parseFrontmatterEntries(
	entries: string[] | undefined,
): Record<string, RuntimeVaultFrontmatterValue> | undefined {
	if (!entries || entries.length === 0) {
		return undefined;
	}
	const frontmatter: Record<string, RuntimeVaultFrontmatterValue> = {};
	for (const entry of entries) {
		const separator = entry.indexOf("=");
		if (separator <= 0) {
			throw new Error(`Invalid --set value "${entry}". Expected key=value.`);
		}
		const key = entry.slice(0, separator).trim();
		if (key.length === 0) {
			throw new Error(`Invalid --set value "${entry}". Key must not be empty.`);
		}
		frontmatter[key] = entry.slice(separator + 1);
	}
	return frontmatter;
}

function collectSet(value: string, previous: string[]): string[] {
	return [...previous, value];
}

// The vault document channel lives on disk, so CLI commands operate on it
// directly without requiring a running runtime. After a mutation we best-effort
// notify the runtime (if one happens to be up) so any open UI refreshes.
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
): Promise<{ store: VaultDocumentStore; repoPath: string; workspaceId: string }> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, { autoCreateIfMissing: true });
	return {
		store: new VaultDocumentStore(workspace.repoPath),
		repoPath: workspace.repoPath,
		workspaceId: workspace.workspaceId,
	};
}

async function resolveBody(body: string | undefined, bodyFile: string | undefined): Promise<string | undefined> {
	if (bodyFile !== undefined) {
		return await readFile(bodyFile, "utf8");
	}
	return body;
}

async function listDocuments(input: { cwd: string; type?: string; projectPath?: string }): Promise<JsonRecord> {
	const { store, repoPath } = await resolveStore(input.projectPath, input.cwd);
	const documents = (await store.list(input.type))
		.sort((left, right) => left.createdAt - right.createdAt)
		.map(formatDocumentRecord);
	return {
		ok: true,
		workspacePath: repoPath,
		type: input.type ?? null,
		documents,
		count: documents.length,
	};
}

async function showDocument(input: { cwd: string; id: string; projectPath?: string }): Promise<JsonRecord> {
	const { store, repoPath } = await resolveStore(input.projectPath, input.cwd);
	const document = await store.get(input.id);
	if (!document) {
		throw new Error(`Vault document "${input.id}" was not found in workspace ${repoPath}.`);
	}
	return { ok: true, workspacePath: repoPath, document: formatDocumentRecord(document) };
}

async function createDocument(input: {
	cwd: string;
	type: string;
	title: string;
	body?: string;
	bodyFile?: string;
	set?: string[];
	projectPath?: string;
}): Promise<JsonRecord> {
	const { store, repoPath, workspaceId } = await resolveStore(input.projectPath, input.cwd);
	const document = await store.create({
		type: input.type,
		title: input.title,
		body: await resolveBody(input.body, input.bodyFile),
		frontmatter: parseFrontmatterEntries(input.set),
	});
	await notifyRuntimeIfRunning(workspaceId);
	return { ok: true, workspacePath: repoPath, document: formatDocumentRecord(document) };
}

async function updateDocument(input: {
	cwd: string;
	id: string;
	title?: string;
	body?: string;
	bodyFile?: string;
	set?: string[];
	projectPath?: string;
}): Promise<JsonRecord> {
	const { store, repoPath, workspaceId } = await resolveStore(input.projectPath, input.cwd);
	const document = await store.update(input.id, {
		title: input.title,
		body: await resolveBody(input.body, input.bodyFile),
		frontmatter: parseFrontmatterEntries(input.set),
	});
	await notifyRuntimeIfRunning(workspaceId);
	return { ok: true, workspacePath: repoPath, document: formatDocumentRecord(document) };
}

async function deleteDocument(input: { cwd: string; id: string; projectPath?: string }): Promise<JsonRecord> {
	const { store, repoPath, workspaceId } = await resolveStore(input.projectPath, input.cwd);
	const deleted = await store.remove(input.id);
	if (!deleted) {
		throw new Error(`Vault document "${input.id}" was not found in workspace ${repoPath}.`);
	}
	await notifyRuntimeIfRunning(workspaceId);
	return { ok: true, workspacePath: repoPath, id: input.id, deleted };
}

async function runVaultCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Vault command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

export function registerVaultCommand(program: Command): void {
	const vault = program
		.command("vault")
		.description("Manage the Kanban knowledge vault (git-committed markdown documents under docs/).");

	const doc = vault.command("doc").description("Create, read, update, and delete vault documents.");

	doc.command("list")
		.description("List vault documents, optionally filtered by type.")
		.option("--type <type>", "Filter by document type (e.g. requirement).")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { type?: string; projectPath?: string }) => {
			await runVaultCommand(
				async () =>
					await listDocuments({ cwd: process.cwd(), type: options.type, projectPath: options.projectPath }),
			);
		});

	doc.command("show")
		.description("Show a single vault document (frontmatter + body).")
		.requiredOption("--id <id>", "Document ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { id: string; projectPath?: string }) => {
			await runVaultCommand(
				async () => await showDocument({ cwd: process.cwd(), id: options.id, projectPath: options.projectPath }),
			);
		});

	doc.command("create")
		.description("Create a new vault document.")
		.requiredOption("--type <type>", "Document type (e.g. requirement).")
		.requiredOption("--title <title>", "Document title.")
		.option("--body <text>", "Markdown body text.")
		.option("--body-file <path>", "Read the markdown body from a local file.")
		.option("--set <key=value>", "Set a frontmatter field. Repeatable.", collectSet, [])
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (options: {
				type: string;
				title: string;
				body?: string;
				bodyFile?: string;
				set?: string[];
				projectPath?: string;
			}) => {
				await runVaultCommand(
					async () =>
						await createDocument({
							cwd: process.cwd(),
							type: options.type,
							title: options.title,
							body: options.body,
							bodyFile: options.bodyFile,
							set: options.set,
							projectPath: options.projectPath,
						}),
				);
			},
		);

	doc.command("update")
		.description("Update a vault document (omitted fields are left unchanged).")
		.requiredOption("--id <id>", "Document ID.")
		.option("--title <title>", "New title (re-slugs the filename, recording a git rename).")
		.option("--body <text>", "Replace the markdown body text.")
		.option("--body-file <path>", "Replace the markdown body from a local file.")
		.option("--set <key=value>", "Set a frontmatter field. Repeatable.", collectSet, [])
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (options: {
				id: string;
				title?: string;
				body?: string;
				bodyFile?: string;
				set?: string[];
				projectPath?: string;
			}) => {
				await runVaultCommand(
					async () =>
						await updateDocument({
							cwd: process.cwd(),
							id: options.id,
							title: options.title,
							body: options.body,
							bodyFile: options.bodyFile,
							set: options.set,
							projectPath: options.projectPath,
						}),
				);
			},
		);

	doc.command("delete")
		.description("Delete a vault document.")
		.requiredOption("--id <id>", "Document ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { id: string; projectPath?: string }) => {
			await runVaultCommand(
				async () => await deleteDocument({ cwd: process.cwd(), id: options.id, projectPath: options.projectPath }),
			);
		});
}
