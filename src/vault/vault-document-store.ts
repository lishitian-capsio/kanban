import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import type { RuntimeVaultDocument, RuntimeVaultFrontmatterValue } from "../core/api-contract";
import { createUniqueTaskId } from "../core/task-id";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { parseVaultDocument, serializeVaultDocument, slugify, type VaultDocument } from "./vault-document";
import { getVaultTypeDefinition } from "./vault-types";

const FILES_DIR = "files";
const DOCS_DIR = "docs";
const DOC_EXTENSION = ".md";

// System frontmatter fields the store owns and promotes onto the wire document,
// so they never appear in the wire `frontmatter` record.
const CREATED_FIELD = "_created";
const UPDATED_FIELD = "_updated";
const TITLE_FIELD = "title";

export interface CreateVaultDocumentInput {
	type: string;
	title: string;
	body?: string;
	frontmatter?: Record<string, RuntimeVaultFrontmatterValue>;
}

export interface UpdateVaultDocumentInput {
	title?: string;
	body?: string;
	frontmatter?: Record<string, RuntimeVaultFrontmatterValue>;
}

export interface ImportVaultDocumentInput {
	/** Caller-supplied id to preserve (no new id is minted). */
	id: string;
	type: string;
	title: string;
	body?: string;
	frontmatter?: Record<string, RuntimeVaultFrontmatterValue>;
	createdAt: number;
	updatedAt: number;
}

interface ScannedDocument {
	doc: VaultDocument;
	absolutePath: string;
	relativePath: string;
}

/**
 * Repo-scoped readable-document channel of the vault, backed by plain markdown
 * files under `<repo>/.kanban/files/docs/<type>/<slug>-<id>.md`. Frontmatter
 * (`_id`/`type`) is the source of truth — documents are *scanned*, never indexed
 * by a manifest, so no index can drift and a hand edit is immediately visible.
 *
 * Mutations serialize on the **same directory lock as the binary blob channel**
 * ({@link FileLibraryStore}) so doc and blob writes never interleave. A torn or
 * unparseable file is silently skipped on read (crash tolerance), and a title
 * change re-slugs the filename via write-new + remove-old inside the lock so git
 * sees a meaningful rename rather than a delete+add of unrelated paths.
 */
export class VaultDocumentStore {
	private readonly filesDir: string;
	private readonly docsDir: string;
	private readonly now: () => number;
	private readonly randomUuid: () => string;

	constructor(
		private readonly repoPath: string,
		options: { now?: () => number; randomUuid?: () => string } = {},
	) {
		this.filesDir = join(getRuntimeHomePath(repoPath), FILES_DIR);
		this.docsDir = join(this.filesDir, DOCS_DIR);
		this.now = options.now ?? Date.now;
		this.randomUuid = options.randomUuid ?? randomUUID;
	}

	async list(type?: string): Promise<RuntimeVaultDocument[]> {
		const entries = await this.scan(type);
		return entries.map((entry) => toRuntimeDocument(entry.doc, entry.relativePath));
	}

	async get(id: string): Promise<RuntimeVaultDocument | null> {
		const entry = await this.findById(id);
		return entry ? toRuntimeDocument(entry.doc, entry.relativePath) : null;
	}

	async create(input: CreateVaultDocumentInput): Promise<RuntimeVaultDocument> {
		return await this.withLock(async () => {
			const entries = await this.scan();
			const id = createUniqueTaskId(new Set(entries.map((entry) => entry.doc.id)), this.randomUuid);
			const timestamp = this.now();
			const definition = getVaultTypeDefinition(input.type);
			const frontmatter: Record<string, RuntimeVaultFrontmatterValue> = {
				...definition?.defaultFrontmatter,
				...input.frontmatter,
				[TITLE_FIELD]: input.title,
				[CREATED_FIELD]: timestamp,
				[UPDATED_FIELD]: timestamp,
			};
			const doc: VaultDocument = { id, type: input.type, frontmatter, body: input.body ?? "" };
			const relativePath = await this.writeDocument(doc);
			return toRuntimeDocument(doc, relativePath);
		});
	}

	/**
	 * Write a document with a caller-supplied id and timestamps rather than minting
	 * new ones — used by migrations that must preserve a record's original identity
	 * and creation time. Serializes deterministically and slugs the filename like
	 * {@link create}; overwrites any existing file for the same slug+id.
	 */
	async importDocument(input: ImportVaultDocumentInput): Promise<RuntimeVaultDocument> {
		return await this.withLock(async () => {
			const definition = getVaultTypeDefinition(input.type);
			const frontmatter: Record<string, RuntimeVaultFrontmatterValue> = {
				...definition?.defaultFrontmatter,
				...input.frontmatter,
				[TITLE_FIELD]: input.title,
				[CREATED_FIELD]: input.createdAt,
				[UPDATED_FIELD]: input.updatedAt,
			};
			const doc: VaultDocument = { id: input.id, type: input.type, frontmatter, body: input.body ?? "" };
			const relativePath = await this.writeDocument(doc);
			return toRuntimeDocument(doc, relativePath);
		});
	}

	async update(id: string, patch: UpdateVaultDocumentInput): Promise<RuntimeVaultDocument> {
		return await this.withLock(async () => {
			const existing = await this.findById(id);
			if (!existing) {
				throw new Error(`Vault document "${id}" was not found.`);
			}

			const frontmatter: Record<string, RuntimeVaultFrontmatterValue> = { ...existing.doc.frontmatter };
			if (patch.frontmatter) {
				for (const [key, value] of Object.entries(patch.frontmatter)) {
					frontmatter[key] = value;
				}
			}
			if (patch.title !== undefined) {
				frontmatter[TITLE_FIELD] = patch.title;
			}
			frontmatter[UPDATED_FIELD] = this.now();

			const doc: VaultDocument = {
				id,
				type: existing.doc.type,
				frontmatter,
				body: patch.body ?? existing.doc.body,
			};

			const relativePath = await this.writeDocument(doc);
			// A title change re-slugs the path; drop the stale file so git records a rename.
			if (relativePath !== existing.relativePath) {
				await rm(existing.absolutePath, { force: true });
			}
			return toRuntimeDocument(doc, relativePath);
		});
	}

	async remove(id: string): Promise<boolean> {
		return await this.withLock(async () => {
			const existing = await this.findById(id);
			if (!existing) {
				return false;
			}
			await rm(existing.absolutePath, { force: true });
			return true;
		});
	}

	private async findById(id: string): Promise<ScannedDocument | null> {
		const entries = await this.scan();
		return entries.find((entry) => entry.doc.id === id) ?? null;
	}

	/** Scan `docs/` (optionally one type's subdir), parsing each `.md` and skipping torn files. */
	private async scan(type?: string): Promise<ScannedDocument[]> {
		const types = type ? [type] : await this.listTypeDirs();
		const entries: ScannedDocument[] = [];
		for (const typeName of types) {
			const dir = join(this.docsDir, typeName);
			const filenames = await listMarkdownFiles(dir);
			for (const filename of filenames) {
				const absolutePath = join(dir, filename);
				const doc = await readDocument(absolutePath);
				if (!doc) {
					continue;
				}
				if (type && doc.type !== type) {
					continue;
				}
				entries.push({ doc, absolutePath, relativePath: relative(this.repoPath, absolutePath) });
			}
		}
		return entries;
	}

	private async listTypeDirs(): Promise<string[]> {
		try {
			const entries = await readdir(this.docsDir, { withFileTypes: true });
			return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch (error) {
			if (isNotFound(error)) {
				return [];
			}
			throw error;
		}
	}

	private async writeDocument(doc: VaultDocument): Promise<string> {
		const absolutePath = this.documentPath(doc);
		await lockedFileSystem.writeTextFileAtomic(absolutePath, serializeVaultDocument(doc), { lock: null });
		return relative(this.repoPath, absolutePath);
	}

	private documentPath(doc: VaultDocument): string {
		const definition = getVaultTypeDefinition(doc.type);
		const slugSource = definition ? doc.frontmatter[definition.slugField] : doc.frontmatter[TITLE_FIELD];
		const slug = slugify(typeof slugSource === "string" ? slugSource : String(slugSource ?? ""));
		return join(this.docsDir, doc.type, `${slug}-${doc.id}${DOC_EXTENSION}`);
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.filesDir, { recursive: true });
		return await lockedFileSystem.withLock({ type: "directory", path: this.filesDir }, operation);
	}
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile() && entry.name.endsWith(DOC_EXTENSION)).map((entry) => entry.name);
	} catch (error) {
		if (isNotFound(error)) {
			return [];
		}
		throw error;
	}
}

async function readDocument(absolutePath: string): Promise<VaultDocument | null> {
	let raw: string;
	try {
		raw = await readFile(absolutePath, "utf8");
	} catch {
		return null;
	}
	try {
		return parseVaultDocument(raw);
	} catch {
		// Torn / hand-broken file — skip it so one bad doc never fails the scan.
		return null;
	}
}

/**
 * Project the engine model onto the wire contract: promote `title` and the
 * `_created`/`_updated` system fields out of `frontmatter` and attach the
 * store-supplied repo-relative location.
 */
function toRuntimeDocument(doc: VaultDocument, relativePath: string): RuntimeVaultDocument {
	const frontmatter: Record<string, RuntimeVaultFrontmatterValue> = {};
	for (const [key, value] of Object.entries(doc.frontmatter)) {
		if (key === TITLE_FIELD || key === CREATED_FIELD || key === UPDATED_FIELD) {
			continue;
		}
		frontmatter[key] = value;
	}
	return {
		id: doc.id,
		type: doc.type,
		title: asString(doc.frontmatter[TITLE_FIELD]),
		body: doc.body,
		frontmatter,
		relativePath,
		createdAt: asNumber(doc.frontmatter[CREATED_FIELD]),
		updatedAt: asNumber(doc.frontmatter[UPDATED_FIELD]),
	};
}

function asString(value: RuntimeVaultFrontmatterValue | undefined): string {
	return typeof value === "string" ? value : "";
}

function asNumber(value: RuntimeVaultFrontmatterValue | undefined): number {
	return typeof value === "number" ? value : 0;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
