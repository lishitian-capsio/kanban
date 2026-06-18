import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { type RuntimeFileItem, runtimeFilesDataSchema } from "../core/api-contract";
import { createUniqueTaskId } from "../core/task-id";
import { lockedFileSystem } from "../fs/locked-file-system";
import { resolveBoardDataLocation } from "../state/workspace-state";
import { classifyFileCategory, detectMimeType } from "./file-mime";

const FILES_DIR = "files";
const BLOBS_DIR = "blobs";
const MANIFEST_FILENAME = "files.json";
const GITATTRIBUTES_FILENAME = ".gitattributes";

// Bulky content (`blobs/**`) is routed through Git LFS so the repository does
// not bloat; the small, diffable `files.json` manifest stays in regular git.
const GITATTRIBUTES_CONTENT = `# Kanban file library — bulky content goes through Git LFS, manifest stays in git.
blobs/** filter=lfs diff=lfs merge=lfs -text
${MANIFEST_FILENAME} -text
`;

export interface AddFileInput {
	name: string;
	bytes: Buffer;
	mime?: string | null;
}

export interface FileBytesResult {
	item: RuntimeFileItem;
	bytes: Buffer;
	/** Base64-encoded content, ready for inline agent vision content. */
	data: string;
	mimeType: string;
}

export interface FilePathResult {
	item: RuntimeFileItem;
	absolutePath: string;
	/** Path relative to the repo root, stable across every worktree checkout. */
	relativePath: string;
}

interface ResolvedMime {
	mime: string;
	category: RuntimeFileItem["category"];
}

/**
 * Repo-scoped file library backed by `<repo>/.kanban/files/`:
 *   - `files.json`        — the manifest (one {@link RuntimeFileItem} per entry)
 *   - `blobs/<id>/<name>` — the stored content
 *
 * Content is committed to git (binaries via Git LFS, configured by the
 * generated `.gitattributes`), so every worktree checkout sees the same files
 * at a stable repo-relative path — no symlinks or copies required.
 */
export class FileLibraryStore {
	private readonly filesDir: string;
	private readonly manifestPath: string;
	private readonly blobsDir: string;
	private readonly gitattributesPath: string;
	private readonly now: () => number;
	private readonly randomUuid: () => string;

	constructor(
		private readonly repoPath: string,
		options: { now?: () => number; randomUuid?: () => string } = {},
	) {
		this.filesDir = join(resolveBoardDataLocation(repoPath).boardDataHome, FILES_DIR);
		this.manifestPath = join(this.filesDir, MANIFEST_FILENAME);
		this.blobsDir = join(this.filesDir, BLOBS_DIR);
		this.gitattributesPath = join(this.filesDir, GITATTRIBUTES_FILENAME);
		this.now = options.now ?? Date.now;
		this.randomUuid = options.randomUuid ?? randomUUID;
	}

	async list(): Promise<RuntimeFileItem[]> {
		const { items } = await this.readManifest();
		return items;
	}

	async get(id: string): Promise<RuntimeFileItem | null> {
		const { items } = await this.readManifest();
		return items.find((item) => item.id === id) ?? null;
	}

	async add(input: AddFileInput): Promise<RuntimeFileItem> {
		const name = basename(input.name.trim());
		if (!name || name === "." || name === "..") {
			throw new Error(`Invalid file name "${input.name}".`);
		}
		const resolved = this.resolveMime(name, input.mime);

		return await this.withLock(async () => {
			const data = await this.readManifest();
			const id = createUniqueTaskId(new Set(data.items.map((item) => item.id)), this.randomUuid);
			await this.writeBlob(id, name, input.bytes);
			const item: RuntimeFileItem = {
				id,
				name,
				mime: resolved.mime,
				category: resolved.category,
				size: input.bytes.byteLength,
				addedAt: this.now(),
			};
			await this.writeManifest({ items: [...data.items, item] });
			await this.ensureGitConfig();
			return item;
		});
	}

	async rename(id: string, name: string): Promise<RuntimeFileItem> {
		const nextName = basename(name.trim());
		if (!nextName || nextName === "." || nextName === "..") {
			throw new Error(`Invalid file name "${name}".`);
		}

		return await this.withLock(async () => {
			const data = await this.readManifest();
			const existing = data.items.find((item) => item.id === id);
			if (!existing) {
				throw new Error(`File "${id}" was not found.`);
			}
			if (existing.name !== nextName) {
				await rename(this.blobPath(id, existing.name), this.blobPath(id, nextName));
			}
			const updated: RuntimeFileItem = { ...existing, name: nextName };
			await this.writeManifest({
				items: data.items.map((item) => (item.id === id ? updated : item)),
			});
			return updated;
		});
	}

	async remove(id: string): Promise<boolean> {
		return await this.withLock(async () => {
			const data = await this.readManifest();
			if (!data.items.some((item) => item.id === id)) {
				return false;
			}
			await rm(this.blobDir(id), { recursive: true, force: true });
			await this.writeManifest({ items: data.items.filter((item) => item.id !== id) });
			return true;
		});
	}

	async getBytes(id: string): Promise<FileBytesResult | null> {
		const item = await this.get(id);
		if (!item) {
			return null;
		}
		const bytes = await readFile(this.blobPath(id, item.name));
		return { item, bytes, data: bytes.toString("base64"), mimeType: item.mime };
	}

	async getPath(id: string): Promise<FilePathResult | null> {
		const item = await this.get(id);
		if (!item) {
			return null;
		}
		const absolutePath = this.blobPath(id, item.name);
		return { item, absolutePath, relativePath: relative(this.repoPath, absolutePath) };
	}

	private resolveMime(name: string, override?: string | null): ResolvedMime {
		const mime = detectMimeType(name, override);
		return { mime, category: classifyFileCategory(mime) };
	}

	private blobDir(id: string): string {
		return join(this.blobsDir, id);
	}

	private blobPath(id: string, name: string): string {
		return join(this.blobDir(id), name);
	}

	private async writeBlob(id: string, name: string, bytes: Buffer): Promise<void> {
		await mkdir(this.blobDir(id), { recursive: true });
		await writeFile(this.blobPath(id, name), bytes);
	}

	private async readManifest(): Promise<{ items: RuntimeFileItem[] }> {
		let raw: string;
		try {
			raw = await readFile(this.manifestPath, "utf8");
		} catch (error) {
			if (isNotFound(error)) {
				return { items: [] };
			}
			throw error;
		}
		return runtimeFilesDataSchema.parse(JSON.parse(raw));
	}

	private async writeManifest(data: { items: RuntimeFileItem[] }): Promise<void> {
		await lockedFileSystem.writeJsonFileAtomic(this.manifestPath, data, { lock: null });
	}

	async ensureGitConfig(): Promise<void> {
		await lockedFileSystem.writeTextFileAtomic(this.gitattributesPath, GITATTRIBUTES_CONTENT, { lock: null });
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.filesDir, { recursive: true });
		return await lockedFileSystem.withLock({ type: "directory", path: this.filesDir }, operation);
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
