import { readFile } from "node:fs/promises";

import type { Command } from "commander";

import type { RuntimeVaultDocument, RuntimeVaultFrontmatterValue } from "../core/api-contract";
import type { VaultFrontmatterValue } from "../vault/vault-document";
import { VaultDocumentStore } from "../vault/vault-document-store";
import { buildVaultRelationGraph } from "../vault/vault-relations";
import { VaultTypeRegistry } from "../vault/vault-type-registry";
import {
	type VaultRelationDefinition,
	type VaultTypeDefinition,
	validateVaultTypeRelations,
} from "../vault/vault-types";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";
import { CliError, type CliWarning } from "./cli-envelope";
import { resolveRequiredId } from "./cli-positional-args";
import { createRuntimeTrpcClient, type JsonRecord, resolveRuntimeWorkspace, toErrorMessage } from "./runtime-workspace";

/** Type ids become `_types/<id>.md` filenames, so they are constrained to a path-safe slug. */
const TYPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Default slug field when a type does not declare one (mirrors the parser's default). */
const DEFAULT_SLUG_FIELD = "title";
/** `--set` keys for a type target its `default_frontmatter` map and carry this prefix. */
const DEFAULT_FRONTMATTER_PREFIX = "default_frontmatter.";

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
): Promise<{ registry: VaultTypeRegistry; repoPath: string; workspaceId: string }> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, { autoCreateIfMissing: true });
	return {
		// The `_types/` tree resolves under the board-data home (see getVaultTypesDir), so these
		// writes are committed board data that travels with board-sync — no extra routing needed.
		registry: new VaultTypeRegistry(workspace.repoPath),
		repoPath: workspace.repoPath,
		workspaceId: workspace.workspaceId,
	};
}

/**
 * Resolve a document store + the type registry it uses over ONE workspace resolution
 * (shared so the store and the relation layer read the same type definitions), for the
 * typed-relation query commands that need both documents and their relation schema.
 */
async function resolveStoreAndTypes(
	projectPath: string | undefined,
	cwd: string,
): Promise<{ store: VaultDocumentStore; registry: VaultTypeRegistry; repoPath: string }> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, { autoCreateIfMissing: true });
	const registry = new VaultTypeRegistry(workspace.repoPath);
	const store = new VaultDocumentStore(workspace.repoPath, { typeRegistry: registry });
	return { store, registry, repoPath: workspace.repoPath };
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
	if (definition.relations) {
		record.relations = definition.relations;
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

/**
 * Parse repeatable `--set default_frontmatter.<key>=<value>` options into a
 * `default_frontmatter` patch. Keys MUST carry the `default_frontmatter.` prefix (the
 * only thing `--set` targets on a *type*, distinguishing it from a document's flat
 * frontmatter); values are kept as raw strings, mirroring `vault doc create --set`.
 */
function parseTypeFrontmatterEntries(entries: string[] | undefined): Record<string, VaultFrontmatterValue> | undefined {
	if (!entries || entries.length === 0) {
		return undefined;
	}
	const result: Record<string, VaultFrontmatterValue> = {};
	for (const entry of entries) {
		const separator = entry.indexOf("=");
		if (separator <= 0) {
			throw new CliError(
				"invalid_argument",
				`Invalid --set value "${entry}". Expected ${DEFAULT_FRONTMATTER_PREFIX}<key>=<value>.`,
			);
		}
		const rawKey = entry.slice(0, separator).trim();
		if (!rawKey.startsWith(DEFAULT_FRONTMATTER_PREFIX)) {
			throw new CliError(
				"invalid_argument",
				`Invalid --set key "${rawKey}". Type frontmatter keys must be prefixed with "${DEFAULT_FRONTMATTER_PREFIX}".`,
			);
		}
		const key = rawKey.slice(DEFAULT_FRONTMATTER_PREFIX.length);
		if (key.length === 0) {
			throw new CliError(
				"invalid_argument",
				`Invalid --set value "${entry}". Key must not be empty after the "${DEFAULT_FRONTMATTER_PREFIX}" prefix.`,
			);
		}
		result[key] = entry.slice(separator + 1);
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Strictly parse one relation's JSON payload into a {@link VaultRelationDefinition}. Shape
 * violations (non-object, wrong scalar types, a `cardinality` outside the enum) are rejected
 * here as `invalid_argument`; the *semantic* checks (name legality, target existence, inverse
 * self-consistency) run later over the whole map via {@link validateVaultTypeRelations}.
 */
function parseRelationDefinition(name: string, raw: unknown): VaultRelationDefinition {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new CliError("invalid_argument", `Relation "${name}" must be a JSON object.`);
	}
	const entry = raw as Record<string, unknown>;
	const relation: VaultRelationDefinition = { name };
	if (entry.label !== undefined) {
		if (typeof entry.label !== "string") {
			throw new CliError("invalid_argument", `Relation "${name}" label must be a string.`);
		}
		relation.label = entry.label;
	}
	if (entry.target !== undefined) {
		relation.target = parseRelationTargetInput(name, entry.target);
	}
	if (entry.cardinality !== undefined) {
		if (entry.cardinality !== "one" && entry.cardinality !== "many") {
			throw new CliError(
				"invalid_argument",
				`Relation "${name}" cardinality must be "one" or "many" (got ${JSON.stringify(entry.cardinality)}).`,
			);
		}
		relation.cardinality = entry.cardinality;
	}
	if (entry.inverse !== undefined) {
		if (typeof entry.inverse !== "string") {
			throw new CliError("invalid_argument", `Relation "${name}" inverse must be a string.`);
		}
		relation.inverse = entry.inverse;
	}
	// Accept both the model key (`inverseLabel`) and the on-disk key (`inverse_label`).
	const inverseLabel = entry.inverseLabel ?? entry.inverse_label;
	if (inverseLabel !== undefined) {
		if (typeof inverseLabel !== "string") {
			throw new CliError("invalid_argument", `Relation "${name}" inverseLabel must be a string.`);
		}
		relation.inverseLabel = inverseLabel;
	}
	return relation;
}

function parseRelationTargetInput(name: string, value: unknown): string | string[] {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string") && value.length > 0) {
		return value;
	}
	throw new CliError(
		"invalid_argument",
		`Relation "${name}" target must be a type id string or a non-empty array of type id strings.`,
	);
}

/**
 * Assemble the relation map from `--relations-file` (a JSON `name → definition` map) then
 * repeatable `--relation '<name>={json}'` entries, the latter overriding by name. Returns
 * `undefined` when neither option supplied anything (so the caller leaves relations unchanged).
 */
async function parseRelationsInput(
	relation: string[] | undefined,
	relationsFile: string | undefined,
): Promise<Record<string, VaultRelationDefinition> | undefined> {
	const result: Record<string, VaultRelationDefinition> = {};
	if (relationsFile !== undefined) {
		let raw: string;
		try {
			raw = await readFile(relationsFile, "utf8");
		} catch (error) {
			throw new CliError(
				"invalid_argument",
				`Could not read --relations-file "${relationsFile}": ${toErrorMessage(error)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new CliError(
				"invalid_argument",
				`--relations-file "${relationsFile}" is not valid JSON: ${toErrorMessage(error)}`,
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new CliError(
				"invalid_argument",
				`--relations-file must contain a JSON object mapping relation name → definition.`,
			);
		}
		for (const [name, value] of Object.entries(parsed)) {
			result[name] = parseRelationDefinition(name, value);
		}
	}
	for (const entry of relation ?? []) {
		const separator = entry.indexOf("=");
		if (separator <= 0) {
			throw new CliError("invalid_argument", `Invalid --relation value "${entry}". Expected <name>={json}.`);
		}
		const name = entry.slice(0, separator).trim();
		if (name.length === 0) {
			throw new CliError(
				"invalid_argument",
				`Invalid --relation value "${entry}". Relation name must not be empty.`,
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(entry.slice(separator + 1));
		} catch (error) {
			throw new CliError("invalid_argument", `Invalid --relation JSON for "${name}": ${toErrorMessage(error)}`);
		}
		result[name] = parseRelationDefinition(name, value);
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

interface TypeFieldInput {
	label?: string;
	description?: string;
	icon?: string;
	slugField?: string;
	status?: string[];
	set?: string[];
	body?: string;
	bodyFile?: string;
	relation?: string[];
	relationsFile?: string;
}

/**
 * Build the {@link VaultTypeDefinition} to write. On create `existing` is undefined and every
 * field comes from the flags; on update, omitted flags fall back to `existing` (缺字段保持不变).
 * `--set` merges into the existing `default_frontmatter` and `--relation`/`--relations-file`
 * merge by relation name — both mirror `vault doc update`'s key-wise merge rather than replacing
 * the whole map.
 */
async function buildTypeDefinition(
	type: string,
	existing: VaultTypeDefinition | undefined,
	input: TypeFieldInput,
): Promise<VaultTypeDefinition> {
	const definition: VaultTypeDefinition = {
		type,
		label: input.label ?? existing?.label ?? "",
		slugField: input.slugField ?? existing?.slugField ?? DEFAULT_SLUG_FIELD,
		body: (await resolveBody(input.body, input.bodyFile)) ?? existing?.body ?? "",
	};

	const description = input.description !== undefined ? input.description : existing?.description;
	if (description !== undefined) {
		definition.description = description;
	}
	const icon = input.icon !== undefined ? input.icon : existing?.icon;
	if (icon !== undefined) {
		definition.icon = icon;
	}
	const statusEnum = input.status && input.status.length > 0 ? input.status : existing?.statusEnum;
	if (statusEnum && statusEnum.length > 0) {
		definition.statusEnum = statusEnum;
	}

	const setPatch = parseTypeFrontmatterEntries(input.set);
	const defaultFrontmatter = setPatch
		? { ...existing?.defaultFrontmatter, ...setPatch }
		: existing?.defaultFrontmatter;
	if (defaultFrontmatter && Object.keys(defaultFrontmatter).length > 0) {
		definition.defaultFrontmatter = defaultFrontmatter;
	}

	const relationsPatch = await parseRelationsInput(input.relation, input.relationsFile);
	const relations = relationsPatch ? { ...existing?.relations, ...relationsPatch } : existing?.relations;
	if (relations && Object.keys(relations).length > 0) {
		definition.relations = relations;
	}
	return definition;
}

/** Fail closed on an empty label or an invalid relation schema (strict write-time validation). */
function assertValidTypeDefinition(definition: VaultTypeDefinition, otherTypes: readonly VaultTypeDefinition[]): void {
	if (definition.label.trim().length === 0) {
		throw new CliError("invalid_argument", "Type label must not be empty.");
	}
	const relationErrors = validateVaultTypeRelations(definition, otherTypes);
	if (relationErrors.length > 0) {
		throw new CliError("invalid_argument", `Invalid type relation schema: ${relationErrors.join("; ")}`);
	}
}

async function createType(
	input: { cwd: string; type: string; projectPath?: string } & TypeFieldInput,
): Promise<JsonRecord> {
	const { registry, repoPath, workspaceId } = await resolveTypeRegistry(input.projectPath, input.cwd);
	if (!TYPE_ID_PATTERN.test(input.type)) {
		throw new CliError(
			"invalid_argument",
			`Invalid type id "${input.type}". Expected a letter or digit, then letters, digits, "_" or "-".`,
		);
	}
	if (await registry.get(input.type)) {
		throw new CliError("invalid_argument", `Vault type "${input.type}" already exists in workspace ${repoPath}.`);
	}
	const definition = await buildTypeDefinition(input.type, undefined, input);
	assertValidTypeDefinition(definition, await registry.list());
	await registry.writeDefinition(definition);
	await notifyRuntimeIfRunning(workspaceId);
	return { ok: true, workspacePath: repoPath, definition: formatTypeDefinitionRecord(definition) };
}

async function updateType(
	input: { cwd: string; type: string; projectPath?: string } & TypeFieldInput,
): Promise<JsonRecord> {
	const { registry, repoPath, workspaceId } = await resolveTypeRegistry(input.projectPath, input.cwd);
	const existing = await registry.get(input.type);
	if (!existing) {
		throw new CliError("document_not_found", `Vault type "${input.type}" was not found in workspace ${repoPath}.`);
	}
	const definition = await buildTypeDefinition(input.type, existing, input);
	assertValidTypeDefinition(definition, await registry.list());
	// Rewrite the file that actually declares this type (may be non-canonically named).
	await registry.writeDefinition(definition, (await registry.locate(input.type)) ?? undefined);
	await notifyRuntimeIfRunning(workspaceId);
	return { ok: true, workspacePath: repoPath, definition: formatTypeDefinitionRecord(definition) };
}

/**
 * Delete a type definition. Non-blocking: documents of this type are NOT removed — the delete
 * proceeds even when they exist, and the count is surfaced as an `orphaned_documents` warning
 * ("<n> 篇文档将变成未注册类型") since those documents become unregistered-type documents (the
 * engine still serves them permissively).
 */
async function deleteType(
	input: { cwd: string; type: string; projectPath?: string },
	warnings: CliWarning[],
): Promise<JsonRecord> {
	const { registry, repoPath, workspaceId } = await resolveTypeRegistry(input.projectPath, input.cwd);
	const existing = await registry.get(input.type);
	if (!existing) {
		throw new CliError("document_not_found", `Vault type "${input.type}" was not found in workspace ${repoPath}.`);
	}
	const documents = await new VaultDocumentStore(repoPath).list(input.type);
	const deleted = await registry.delete(input.type);
	await notifyRuntimeIfRunning(workspaceId);
	if (documents.length > 0) {
		warnings.push({ code: "orphaned_documents", message: `${documents.length} 篇文档将变成未注册类型` });
	}
	return { ok: true, workspacePath: repoPath, type: input.type, deleted, orphanedDocuments: documents.length };
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

/**
 * Validate typed relations across the vault (read-only): every document's declared
 * relations are resolved and any that dangle (target resolves to nothing), point at the
 * wrong target type, or exceed a `cardinality: one` are reported. Optionally narrowed to
 * one document type and/or one relation name.
 */
async function checkRelations(input: {
	cwd: string;
	type?: string;
	relation?: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const { store, registry, repoPath } = await resolveStoreAndTypes(input.projectPath, input.cwd);
	const [documents, typeDefinitions] = await Promise.all([store.list(), registry.list()]);
	const graph = buildVaultRelationGraph(documents, typeDefinitions);
	const issues = graph.issues({ type: input.type, relation: input.relation });
	return {
		ok: true,
		workspacePath: repoPath,
		type: input.type ?? null,
		relation: input.relation ?? null,
		issues,
		count: issues.length,
	};
}

/**
 * Walk typed relations out of (forward) or into (inverse) a document, turning stored
 * links into a reasoning traversal (e.g. a decision-supersession chain, or every
 * requirement anchored to a customer). Read-only.
 */
async function traverseRelations(input: {
	cwd: string;
	id: string;
	relation?: string;
	inverse: boolean;
	depth: number;
	projectPath?: string;
}): Promise<JsonRecord> {
	const { store, registry, repoPath } = await resolveStoreAndTypes(input.projectPath, input.cwd);
	const [documents, typeDefinitions] = await Promise.all([store.list(), registry.list()]);
	const graph = buildVaultRelationGraph(documents, typeDefinitions);
	const result = graph.traverse(input.id, {
		relation: input.relation,
		direction: input.inverse ? "inverse" : "forward",
		maxDepth: input.depth,
	});
	if (!result) {
		throw new CliError("document_not_found", `Vault document "${input.id}" was not found in workspace ${repoPath}.`);
	}
	return { ok: true, workspacePath: repoPath, ...result, count: result.nodes.length };
}

function parseDepthOption(value: string): number {
	const depth = Number.parseInt(value, 10);
	if (!Number.isFinite(depth) || depth < 1) {
		throw new Error(`Invalid --depth value "${value}". Expected a positive integer.`);
	}
	return depth;
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
		.argument("[type]", "Type id, e.g. requirement (positional, preferred over --type).")
		.option("--type <type>", "Deprecated: pass the type id as the positional <type> instead.")
		.action(async function (this: Command, typeArg: string | undefined, options: { type?: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"vault.type.show",
				async () => {
					const resolved = resolveRequiredId({
						positional: typeArg,
						legacyFlagValue: options.type,
						legacyFlagName: "--type",
						positionalLabel: "<type>",
						missingMessage: "vault type show requires a type id. Pass it as the positional <type> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await showType({ cwd: process.cwd(), type: resolved.id, projectPath: globals.projectPath });
				},
				{ globals, warnings },
			);
		});

	type
		.command("create")
		.description("Create a new document type (writes docs/_types/<type>.md through the canonical serializer).")
		.requiredOption("--type <type>", "Type id — used as the `type:` value and the filename.")
		.requiredOption("--label <label>", "Human display label.")
		.option("--description <text>", "One-line 'when to use me', shown in type pickers.")
		.option("--icon <name>", "Lucide icon name hint.")
		.option("--slug-field <field>", "Frontmatter field seeding the filename slug (defaults to title).")
		.option("--status <value>", "Add a status enum value. Repeatable.", collectSet, [])
		.option(
			"--set <default_frontmatter.key=value>",
			"Set a default_frontmatter field (keys prefixed default_frontmatter.). Repeatable.",
			collectSet,
			[],
		)
		.option("--body <text>", "Authoring-prompt markdown body.")
		.option("--body-file <path>", "Read the authoring-prompt body from a local file.")
		.option("--relation <name={json}>", "Add a typed relation by name. Repeatable.", collectSet, [])
		.option("--relations-file <path>", "Read a JSON map of relation name → definition.")
		.action(async function (this: Command, options: { type: string } & TypeFieldInput) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"vault.type.create",
				async () =>
					await createType({
						cwd: process.cwd(),
						type: options.type,
						label: options.label,
						description: options.description,
						icon: options.icon,
						slugField: options.slugField,
						status: options.status,
						set: options.set,
						body: options.body,
						bodyFile: options.bodyFile,
						relation: options.relation,
						relationsFile: options.relationsFile,
						projectPath: globals.projectPath,
					}),
				{ globals },
			);
		});

	type
		.command("update")
		.description("Update a document type (omitted fields are left unchanged; --set and --relation merge by key).")
		.requiredOption("--type <type>", "Type id to update.")
		.option("--label <label>", "New display label.")
		.option("--description <text>", "New one-line description.")
		.option("--icon <name>", "New Lucide icon name hint.")
		.option("--slug-field <field>", "New slug field.")
		.option("--status <value>", "Replace the status enum with these values. Repeatable.", collectSet, [])
		.option(
			"--set <default_frontmatter.key=value>",
			"Merge a default_frontmatter field (keys prefixed default_frontmatter.). Repeatable.",
			collectSet,
			[],
		)
		.option("--body <text>", "Replace the authoring-prompt body.")
		.option("--body-file <path>", "Replace the authoring-prompt body from a local file.")
		.option("--relation <name={json}>", "Add or replace a typed relation by name. Repeatable.", collectSet, [])
		.option("--relations-file <path>", "Merge a JSON map of relation name → definition.")
		.action(async function (this: Command, options: { type: string } & TypeFieldInput) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"vault.type.update",
				async () =>
					await updateType({
						cwd: process.cwd(),
						type: options.type,
						label: options.label,
						description: options.description,
						icon: options.icon,
						slugField: options.slugField,
						status: options.status,
						set: options.set,
						body: options.body,
						bodyFile: options.bodyFile,
						relation: options.relation,
						relationsFile: options.relationsFile,
						projectPath: globals.projectPath,
					}),
				{ globals },
			);
		});

	type
		.command("delete")
		.description("Delete a document type. Non-blocking: existing documents of this type are kept (and warned about).")
		.requiredOption("--type <type>", "Type id to delete.")
		.action(async function (this: Command, options: { type: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"vault.type.delete",
				async () =>
					await deleteType({ cwd: process.cwd(), type: options.type, projectPath: globals.projectPath }, warnings),
				{ globals, warnings },
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
		.argument("[id]", "Document ID (positional, preferred over --id).")
		.option("--id <id>", "Deprecated: pass the document ID as the positional <id> instead.")
		.action(async function (this: Command, idArg: string | undefined, options: { id?: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"vault.doc.show",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.id,
						legacyFlagName: "--id",
						missingMessage: "vault doc show requires a document id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await showDocument({ cwd: process.cwd(), id: resolved.id, projectPath: globals.projectPath });
				},
				{ globals, warnings },
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
		.argument("[id]", "Document ID (positional, preferred over --id).")
		.option("--id <id>", "Deprecated: pass the document ID as the positional <id> instead.")
		.option("--title <title>", "New title (re-slugs the filename, recording a git rename).")
		.option("--body <text>", "Replace the markdown body text.")
		.option("--body-file <path>", "Replace the markdown body from a local file.")
		.option("--set <key=value>", "Set a frontmatter field. Repeatable.", collectSet, [])
		.action(async function (
			this: Command,
			idArg: string | undefined,
			options: {
				id?: string;
				title?: string;
				body?: string;
				bodyFile?: string;
				set?: string[];
			},
		) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"vault.doc.update",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.id,
						legacyFlagName: "--id",
						missingMessage: "vault doc update requires a document id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await updateDocument({
						cwd: process.cwd(),
						id: resolved.id,
						title: options.title,
						body: options.body,
						bodyFile: options.bodyFile,
						set: options.set,
						projectPath: globals.projectPath,
					});
				},
				{ globals, warnings },
			);
		});

	doc.command("delete")
		.description("Delete a vault document.")
		.argument("[id]", "Document ID (positional, preferred over --id).")
		.option("--id <id>", "Deprecated: pass the document ID as the positional <id> instead.")
		.action(async function (this: Command, idArg: string | undefined, options: { id?: string }) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"vault.doc.delete",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.id,
						legacyFlagName: "--id",
						missingMessage: "vault doc delete requires a document id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await deleteDocument({ cwd: process.cwd(), id: resolved.id, projectPath: globals.projectPath });
				},
				{ globals, warnings },
			);
		});

	const relations = vault
		.command("relations")
		.description("Query typed relations declared by document types (read-only) — validate and traverse.");

	relations
		.command("check")
		.description("Report documents whose typed relations dangle, target the wrong type, or exceed cardinality.")
		.option("--type <type>", "Only check documents of this type (e.g. requirement).")
		.option("--relation <name>", "Only check this relation (e.g. customer).")
		.action(async function (this: Command, options: { type?: string; relation?: string }) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"vault.relations.check",
				async () =>
					await checkRelations({
						cwd: process.cwd(),
						type: options.type,
						relation: options.relation,
						projectPath: globals.projectPath,
					}),
				{ globals },
			);
		});

	relations
		.command("traverse")
		.description("Walk typed relations out of (or into) a document, following resolved links up to a depth.")
		.argument("[id]", "Start document ID (positional, preferred over --id).")
		.option("--id <id>", "Deprecated: pass the document ID as the positional <id> instead.")
		.option("--relation <name>", "Follow only this relation (default: every declared relation).")
		.option("--inverse", "Follow reverse edges (documents pointing at the start) instead of forward.", false)
		.option("--depth <n>", "Maximum hop distance from the start document (default 1).", parseDepthOption)
		.action(async function (
			this: Command,
			idArg: string | undefined,
			options: { id?: string; relation?: string; inverse?: boolean; depth?: number },
		) {
			const globals = readGlobalCliOptions(this);
			const warnings: CliWarning[] = [];
			await runCliCommand(
				"vault.relations.traverse",
				async () => {
					const resolved = resolveRequiredId({
						positional: idArg,
						legacyFlagValue: options.id,
						legacyFlagName: "--id",
						missingMessage:
							"vault relations traverse requires a document id. Pass it as the positional <id> argument.",
					});
					if (resolved.warning) {
						warnings.push(resolved.warning);
					}
					return await traverseRelations({
						cwd: process.cwd(),
						id: resolved.id,
						relation: options.relation,
						inverse: options.inverse ?? false,
						depth: options.depth ?? 1,
						projectPath: globals.projectPath,
					});
				},
				{ globals, warnings },
			);
		});
}
