import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import type {
	RuntimeVaultDocument,
	RuntimeVaultFrontmatterValue,
	RuntimeVaultSearchResult,
} from "../core/api-contract";
import { createUniqueTaskId } from "../core/task-id";
import { mapFilesConcurrent } from "../fs/concurrent-files";
import { lockedFileSystem } from "../fs/locked-file-system";
import { parseVaultDocument, serializeVaultDocument, slugify, type VaultDocument } from "./vault-document";
import type { VaultExportEntry } from "./vault-export";
import { buildVaultLinkIndex, type VaultLinkIndex } from "./vault-link-index";
import { getVaultDocsDir, getVaultFilesDir } from "./vault-paths";
import { getVaultReadCache, type VaultReadCache, type VaultReadResult, type VaultScanResult } from "./vault-read-cache";
import { searchVaultDocuments, type VaultSearchOptions } from "./vault-search";
import { VaultTypeRegistry } from "./vault-type-registry";
import type { VaultRelationDefinition } from "./vault-types";

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
	private readonly typeRegistry: VaultTypeRegistry;
	/** Process-wide read cache shared by every store instance for this vault. */
	private readonly cache: VaultReadCache;

	constructor(
		private readonly repoPath: string,
		options: { now?: () => number; randomUuid?: () => string; typeRegistry?: VaultTypeRegistry } = {},
	) {
		this.filesDir = getVaultFilesDir(repoPath);
		this.docsDir = getVaultDocsDir(repoPath);
		this.now = options.now ?? Date.now;
		this.randomUuid = options.randomUuid ?? randomUUID;
		this.typeRegistry = options.typeRegistry ?? new VaultTypeRegistry(repoPath);
		this.cache = getVaultReadCache(this.docsDir);
	}

	async list(type?: string): Promise<RuntimeVaultDocument[]> {
		const { documents } = await this.readCachedDocuments();
		return type ? documents.filter((document) => document.type === type) : documents.slice();
	}

	/**
	 * The full link index over the vault, memoized per cache version so repeated
	 * `getDocumentLinks` calls (and successive documents) reuse one built graph
	 * instead of rebuilding all three resolver maps + edges every request.
	 */
	async getLinkIndex(): Promise<VaultLinkIndex> {
		const { version, documents } = await this.readCachedDocuments();
		const relationsByType = await this.loadTypeRelations();
		// Fold a relations fingerprint into the memo key so a type's `relations:` edit
		// rebuilds the index even when the document set (and its version) is unchanged.
		const key = `link-index:${JSON.stringify([...relationsByType.entries()])}`;
		return this.cache.derive(key, version, () => buildVaultLinkIndex(documents, relationsByType));
	}

	/** Declared relations keyed by type name, for tagging links with their typed relation. */
	private async loadTypeRelations(): Promise<Map<string, Record<string, VaultRelationDefinition>>> {
		const definitions = await this.typeRegistry.list();
		const byType = new Map<string, Record<string, VaultRelationDefinition>>();
		for (const definition of definitions) {
			if (definition.relations) {
				byType.set(definition.type, definition.relations);
			}
		}
		return byType;
	}

	/** Full-text search over the cached documents — no per-keystroke disk read or parse. */
	async search(query: string, options?: VaultSearchOptions): Promise<RuntimeVaultSearchResult[]> {
		const { documents } = await this.readCachedDocuments();
		return searchVaultDocuments(documents, query, options);
	}

	async get(id: string): Promise<RuntimeVaultDocument | null> {
		const entry = await this.findById(id);
		return entry ? toRuntimeDocument(entry.doc, entry.relativePath) : null;
	}

	/**
	 * The raw on-disk markdown for one document, for download. Reads the file bytes
	 * directly rather than re-serializing the parsed model, so the export is
	 * byte-identical to what git tracks (including any hand edits the canonical
	 * serializer would normalize away). Returns null when the id is unknown.
	 */
	async exportDocument(id: string): Promise<{ fileName: string; content: string } | null> {
		const located = await this.findById(id);
		if (!located) {
			return null;
		}
		const content = await readFile(located.absolutePath, "utf8");
		return { fileName: basename(located.absolutePath), content };
	}

	/**
	 * Raw on-disk markdown for many documents, each tagged with its archive-relative
	 * path (`docs/<type>/<file>`) so a zip reproduces the vault tree. The vault is
	 * scanned once and read byte-exact; entries are returned in the caller's id order
	 * and unknown ids are silently dropped (a torn file is skipped, like every scan).
	 */
	async exportDocuments(ids: string[]): Promise<VaultExportEntry[]> {
		if (ids.length === 0) {
			return [];
		}
		const wanted = new Set(ids);
		const files = await this.collectDocumentFiles();
		const byId = new Map<string, VaultExportEntry>();
		await Promise.all(
			files.map(async (file) => {
				let content: string;
				try {
					content = await readFile(file.absolutePath, "utf8");
				} catch {
					return;
				}
				let id: string;
				try {
					id = parseVaultDocument(content).id;
				} catch {
					return;
				}
				if (!wanted.has(id)) {
					return;
				}
				byId.set(id, { entryPath: relative(this.filesDir, file.absolutePath), content });
			}),
		);
		return ids.map((id) => byId.get(id)).filter((entry): entry is VaultExportEntry => entry !== undefined);
	}

	async create(input: CreateVaultDocumentInput): Promise<RuntimeVaultDocument> {
		return await this.withLock(async () => {
			const entries = await this.scan();
			const id = createUniqueTaskId(new Set(entries.map((entry) => entry.doc.id)), this.randomUuid);
			const timestamp = this.now();
			const definition = await this.typeRegistry.get(input.type);
			const frontmatter: Record<string, RuntimeVaultFrontmatterValue> = {
				...definition?.defaultFrontmatter,
				...input.frontmatter,
				[TITLE_FIELD]: input.title,
				[CREATED_FIELD]: timestamp,
				[UPDATED_FIELD]: timestamp,
			};
			const doc: VaultDocument = { id, type: input.type, frontmatter, body: input.body ?? "" };
			const relativePath = await this.writeDocument(doc);
			this.cache.invalidate();
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
			const definition = await this.typeRegistry.get(input.type);
			const frontmatter: Record<string, RuntimeVaultFrontmatterValue> = {
				...definition?.defaultFrontmatter,
				...input.frontmatter,
				[TITLE_FIELD]: input.title,
				[CREATED_FIELD]: input.createdAt,
				[UPDATED_FIELD]: input.updatedAt,
			};
			const doc: VaultDocument = { id: input.id, type: input.type, frontmatter, body: input.body ?? "" };
			const relativePath = await this.writeDocument(doc);
			this.cache.invalidate();
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
			this.cache.invalidate();
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
			this.cache.invalidate();
			return true;
		});
	}

	/**
	 * Locate a single document by id without parsing the whole vault. Filenames are
	 * `<slug>-<id>.md` and ids are dash-free, so the id is always the final
	 * hyphen-delimited segment — the candidate file is found by a cheap filename
	 * match (directory listings only, no `gray-matter` parse), and only that file is
	 * read. A malformed/hand-created filename can end with `-<id>.md` yet hold a
	 * different frontmatter id, so the parsed `doc.id` is verified before accepting.
	 */
	private async findById(id: string): Promise<ScannedDocument | null> {
		const suffix = `-${id}${DOC_EXTENSION}`;
		const types = await this.listTypeDirs();
		for (const typeName of types) {
			const dir = join(this.docsDir, typeName);
			const filenames = await listMarkdownFiles(dir);
			for (const filename of filenames) {
				if (!filename.endsWith(suffix)) {
					continue;
				}
				const absolutePath = join(dir, filename);
				const doc = await readDocument(absolutePath);
				if (!doc || doc.id !== id) {
					continue;
				}
				return { doc, absolutePath, relativePath: relative(this.repoPath, absolutePath) };
			}
		}
		return null;
	}

	/**
	 * Read the full document list through the shared cache. A warm read pays only a
	 * cheap fs signature probe; a cold/stale read re-scans and re-parses every file.
	 */
	private async readCachedDocuments(): Promise<VaultReadResult> {
		return await this.cache.read({
			computeSignature: () => this.computeSignature(),
			scan: () => this.scanAll(),
		});
	}

	/** Expensive scan over the whole vault: read + parse every `.md`, with its fs signature. */
	private async scanAll(): Promise<VaultScanResult> {
		const files = await this.collectDocumentFiles();
		// Bounded by the shared file budget: each doc opens two fds (stat + read), so a
		// vault with thousands of docs would otherwise blow the fd table on first scan.
		const probed = await mapFilesConcurrent(files, async (file) => {
			const [stats, doc] = await Promise.all([safeStat(file.absolutePath), readDocument(file.absolutePath)]);
			return { file, stats, doc };
		});

		const documents: RuntimeVaultDocument[] = [];
		const signatureParts: string[] = [];
		for (const { file, stats, doc } of probed) {
			if (stats) {
				signatureParts.push(signatureEntry(file.relativePath, stats.mtimeMs, stats.size));
			}
			if (doc) {
				documents.push(toRuntimeDocument(doc, file.relativePath));
			}
		}
		return { documents, signature: signatureParts.sort().join("\n") };
	}

	/** Cheap fs probe: list + `stat` every `.md` (no contents read) → a change-detecting signature. */
	private async computeSignature(): Promise<string> {
		const files = await this.collectDocumentFiles();
		const parts = await mapFilesConcurrent(files, async (file) => {
			const stats = await safeStat(file.absolutePath);
			return stats ? signatureEntry(file.relativePath, stats.mtimeMs, stats.size) : null;
		});
		return parts
			.filter((part): part is string => part !== null)
			.sort()
			.join("\n");
	}

	/** Enumerate every document file path across all scannable type dirs (no read/parse). */
	private async collectDocumentFiles(): Promise<{ absolutePath: string; relativePath: string }[]> {
		const types = await this.listTypeDirs();
		const perType = await Promise.all(
			types.map(async (typeName) => {
				const dir = join(this.docsDir, typeName);
				const filenames = await listMarkdownFiles(dir);
				return filenames.map((filename) => {
					const absolutePath = join(dir, filename);
					return { absolutePath, relativePath: relative(this.repoPath, absolutePath) };
				});
			}),
		);
		return perType.flat();
	}

	/** Scan `docs/` (optionally one type's subdir), parsing each `.md` and skipping torn files. */
	private async scan(type?: string): Promise<ScannedDocument[]> {
		const types = type ? [type] : await this.listTypeDirs();
		const perType = await Promise.all(types.map((typeName) => this.scanTypeDir(typeName, type)));
		return perType.flat();
	}

	/** Parse every `.md` in one type's subdir in parallel, preserving filename order and skipping torn files. */
	private async scanTypeDir(typeName: string, filterType: string | undefined): Promise<ScannedDocument[]> {
		const dir = join(this.docsDir, typeName);
		const filenames = await listMarkdownFiles(dir);
		const parsed = await Promise.all(
			filenames.map(async (filename): Promise<ScannedDocument | null> => {
				const absolutePath = join(dir, filename);
				const doc = await readDocument(absolutePath);
				if (!doc) {
					return null;
				}
				if (filterType && doc.type !== filterType) {
					return null;
				}
				return { doc, absolutePath, relativePath: relative(this.repoPath, absolutePath) };
			}),
		);
		return parsed.filter((entry): entry is ScannedDocument => entry !== null);
	}

	private async listTypeDirs(): Promise<string[]> {
		try {
			const entries = await readdir(this.docsDir, { withFileTypes: true });
			// `_`-prefixed dirs (e.g. `_types/`) describe the vault rather than holding
			// user documents, so they are not scannable document types.
			return entries
				.filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
				.map((entry) => entry.name);
		} catch (error) {
			if (isNotFound(error)) {
				return [];
			}
			throw error;
		}
	}

	private async writeDocument(doc: VaultDocument): Promise<string> {
		const absolutePath = await this.documentPath(doc);
		await lockedFileSystem.writeTextFileAtomic(absolutePath, serializeVaultDocument(doc), { lock: null });
		return relative(this.repoPath, absolutePath);
	}

	private async documentPath(doc: VaultDocument): Promise<string> {
		const definition = await this.typeRegistry.get(doc.type);
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

/** One signature line for a file: path + mtime + size detects any add/remove/in-place edit. */
function signatureEntry(relativePath: string, mtimeMs: number, size: number): string {
	return `${relativePath}:${mtimeMs}:${size}`;
}

async function safeStat(absolutePath: string): Promise<{ mtimeMs: number; size: number } | null> {
	try {
		const stats = await stat(absolutePath);
		return { mtimeMs: stats.mtimeMs, size: stats.size };
	} catch {
		return null;
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
