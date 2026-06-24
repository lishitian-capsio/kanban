import { readFile } from "node:fs/promises";

import type { Command } from "commander";

import type { RuntimeVaultDocument, RuntimeVaultFrontmatterValue } from "../core/api-contract";
import { VaultDocumentStore } from "../vault/vault-document-store";
import { VaultTypeRegistry } from "../vault/vault-type-registry";
import type { VaultTypeDefinition } from "../vault/vault-types";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";
import { createRuntimeTrpcClient, type JsonRecord, resolveRuntimeWorkspace } from "./runtime-workspace";

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

async function resolveTypeRegistry(
	projectPath: string | undefined,
	cwd: string,
): Promise<{ registry: VaultTypeRegistry; repoPath: string }> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, { autoCreateIfMissing: true });
	return { registry: new VaultTypeRegistry(workspace.repoPath), repoPath: workspace.repoPath };
}

/**
 * The light "index" tier of a type — the metadata a picker or the agent's
 * type-discovery step needs to decide *which* type, deliberately WITHOUT the
 * authoring prompt (`body`). Mirrors how a skill exposes only name/description
 * until it is actually loaded.
 */
function formatTypeIndexRecord(definition: VaultTypeDefinition): JsonRecord {
	const record: JsonRecord = { type: definition.type, label: definition.label };
	if (definition.description !== undefined) {
		record.description = definition.description;
	}
	if (definition.icon !== undefined) {
		record.icon = definition.icon;
	}
	if (definition.statusEnum) {
		record.statusEnum = [...definition.statusEnum];
	}
	return record;
}

/** The full type definition, including the authoring prompt (`body`) — the "loaded" tier. */
function formatTypeDefinitionRecord(definition: VaultTypeDefinition): JsonRecord {
	const record: JsonRecord = { ...formatTypeIndexRecord(definition), slugField: definition.slugField };
	if (definition.defaultFrontmatter) {
		record.defaultFrontmatter = definition.defaultFrontmatter;
	}
	record.body = definition.body;
	return record;
}

async function listTypes(input: { cwd: string; projectPath?: string }): Promise<JsonRecord> {
	const { registry, repoPath } = await resolveTypeRegistry(input.projectPath, input.cwd);
	const types = (await registry.list())
		.sort((left, right) => left.type.localeCompare(right.type))
		.map(formatTypeIndexRecord);
	return { ok: true, workspacePath: repoPath, types, count: types.length };
}

async function showType(input: { cwd: string; type: string; projectPath?: string }): Promise<JsonRecord> {
	const { registry, repoPath } = await resolveTypeRegistry(input.projectPath, input.cwd);
	const definition = await registry.get(input.type);
	if (!definition) {
		throw new Error(`Vault type "${input.type}" was not found in workspace ${repoPath}.`);
	}
	return { ok: true, workspacePath: repoPath, definition: formatTypeDefinitionRecord(definition) };
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

export function registerVaultCommand(program: Command): void {
	const vault = program
		.command("vault")
		.description("Manage the Kanban knowledge vault (git-committed markdown documents under docs/).");

	const type = vault
		.command("type")
		.description("Inspect the vault's document types (data-driven, from docs/_types/).");

	type
		.command("list")
		.description("List document types as a light index (name + description + metadata, no authoring prompt).")
		.action(async function (this: Command) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"vault.type.list",
				async () => await listTypes({ cwd: process.cwd(), projectPath: globals.projectPath }),
				{ globals },
			);
		});

	type
		.command("show")
		.description("Show a type's full definition: metadata + the self-governing authoring prompt (body).")
		.requiredOption("--type <type>", "Type id (e.g. requirement).")
		.action(async function (this: Command, options: { type: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"vault.type.show",
				async () => await showType({ cwd: process.cwd(), type: options.type, projectPath: globals.projectPath }),
				{ globals },
			);
		});

	const doc = vault.command("doc").description("Create, read, update, and delete vault documents.");

	doc.command("list")
		.description("List vault documents, optionally filtered by type.")
		.option("--type <type>", "Filter by document type (e.g. requirement).")
		.action(async function (this: Command, options: { type?: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"vault.doc.list",
				async () =>
					await listDocuments({ cwd: process.cwd(), type: options.type, projectPath: globals.projectPath }),
				{ globals },
			);
		});

	doc.command("show")
		.description("Show a single vault document (frontmatter + body).")
		.requiredOption("--id <id>", "Document ID.")
		.action(async function (this: Command, options: { id: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"vault.doc.show",
				async () => await showDocument({ cwd: process.cwd(), id: options.id, projectPath: globals.projectPath }),
				{ globals },
			);
		});

	doc.command("create")
		.description("Create a new vault document.")
		.requiredOption("--type <type>", "Document type (e.g. requirement).")
		.requiredOption("--title <title>", "Document title.")
		.option("--body <text>", "Markdown body text.")
		.option("--body-file <path>", "Read the markdown body from a local file.")
		.option("--set <key=value>", "Set a frontmatter field. Repeatable.", collectSet, [])
		.action(async function (
			this: Command,
			options: {
				type: string;
				title: string;
				body?: string;
				bodyFile?: string;
				set?: string[];
			},
		) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"vault.doc.create",
				async () =>
					await createDocument({
						cwd: process.cwd(),
						type: options.type,
						title: options.title,
						body: options.body,
						bodyFile: options.bodyFile,
						set: options.set,
						projectPath: globals.projectPath,
					}),
				{ globals },
			);
		});

	doc.command("update")
		.description("Update a vault document (omitted fields are left unchanged).")
		.requiredOption("--id <id>", "Document ID.")
		.option("--title <title>", "New title (re-slugs the filename, recording a git rename).")
		.option("--body <text>", "Replace the markdown body text.")
		.option("--body-file <path>", "Replace the markdown body from a local file.")
		.option("--set <key=value>", "Set a frontmatter field. Repeatable.", collectSet, [])
		.action(async function (
			this: Command,
			options: {
				id: string;
				title?: string;
				body?: string;
				bodyFile?: string;
				set?: string[];
			},
		) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"vault.doc.update",
				async () =>
					await updateDocument({
						cwd: process.cwd(),
						id: options.id,
						title: options.title,
						body: options.body,
						bodyFile: options.bodyFile,
						set: options.set,
						projectPath: globals.projectPath,
					}),
				{ globals },
			);
		});

	doc.command("delete")
		.description("Delete a vault document.")
		.requiredOption("--id <id>", "Document ID.")
		.action(async function (this: Command, options: { id: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"vault.doc.delete",
				async () => await deleteDocument({ cwd: process.cwd(), id: options.id, projectPath: globals.projectPath }),
				{ globals },
			);
		});
}
