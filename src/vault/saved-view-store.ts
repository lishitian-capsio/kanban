import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
	RuntimeVaultFilterGroup,
	RuntimeVaultView,
	RuntimeVaultViewCreateRequest,
	RuntimeVaultViewUpdateRequest,
} from "../core/api-contract";
import { runtimeVaultViewSchema } from "../core/api-contract";
import { createUniqueTaskId } from "../core/task-id";
import { lockedFileSystem } from "../fs/locked-file-system";
import { readShardDir } from "../state/sharded-json-store";
import { getRuntimeHomePath } from "../state/workspace-state";

const FILES_DIR = "files";
const VIEWS_DIR = "views";
const EMPTY_FILTERS: RuntimeVaultFilterGroup = { all: [] };

/**
 * Repo-scoped store for vault *saved views* — a saved filter/sort/layout over one
 * document type. Each view is its own committed shard at
 * `<repo>/.kanban/files/views/<id>.json`, mirroring the task-shard convention so
 * editing different views on different branches never produces a merge conflict.
 *
 * Mutations serialize on the **same directory lock as the document + blob
 * channels** (the shared `files/` dir) so view and doc writes never interleave.
 * Reads go through {@link readShardDir}, which validates each shard against
 * {@link runtimeVaultViewSchema} (applying its defaults) and skips nothing — a
 * malformed view shard fails loudly with its path.
 */
export class SavedViewStore {
	private readonly filesDir: string;
	private readonly viewsDir: string;
	private readonly now: () => number;
	private readonly randomUuid: () => string;

	constructor(repoPath: string, options: { now?: () => number; randomUuid?: () => string } = {}) {
		this.filesDir = join(getRuntimeHomePath(repoPath), FILES_DIR);
		this.viewsDir = join(this.filesDir, VIEWS_DIR);
		this.now = options.now ?? Date.now;
		this.randomUuid = options.randomUuid ?? randomUUID;
	}

	/** List views (optionally for one type), ordered by `order` then `createdAt`. */
	async list(type?: string): Promise<RuntimeVaultView[]> {
		const views = [...(await this.readAll()).values()];
		const filtered = type ? views.filter((view) => view.type === type) : views;
		return filtered.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
	}

	async get(id: string): Promise<RuntimeVaultView | null> {
		return (await this.readAll()).get(id) ?? null;
	}

	async create(input: RuntimeVaultViewCreateRequest): Promise<RuntimeVaultView> {
		return await this.withLock(async () => {
			const existing = await this.readAll();
			const id = createUniqueTaskId(new Set(existing.keys()), this.randomUuid);
			const timestamp = this.now();
			const view = runtimeVaultViewSchema.parse({
				id,
				type: input.type,
				name: input.name,
				icon: input.icon ?? null,
				order: input.order ?? 0,
				layout: input.layout ?? "table",
				sort: input.sort ?? null,
				listPropertiesDisplay: input.listPropertiesDisplay ?? [],
				filters: input.filters ?? EMPTY_FILTERS,
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			await this.write(view);
			return view;
		});
	}

	async update(id: string, patch: Omit<RuntimeVaultViewUpdateRequest, "id">): Promise<RuntimeVaultView> {
		return await this.withLock(async () => {
			const existing = (await this.readAll()).get(id);
			if (!existing) {
				throw new Error(`Vault view "${id}" was not found.`);
			}
			const view = runtimeVaultViewSchema.parse({
				...existing,
				...definedFields(patch),
				id: existing.id,
				type: existing.type,
				createdAt: existing.createdAt,
				updatedAt: this.now(),
			});
			await this.write(view);
			return view;
		});
	}

	async remove(id: string): Promise<boolean> {
		return await this.withLock(async () => {
			if (!(await this.readAll()).has(id)) {
				return false;
			}
			await rm(this.viewPath(id), { force: true });
			return true;
		});
	}

	private async readAll(): Promise<Map<string, RuntimeVaultView>> {
		return await readShardDir(this.viewsDir, runtimeVaultViewSchema);
	}

	private async write(view: RuntimeVaultView): Promise<void> {
		await lockedFileSystem.writeJsonFileAtomic(this.viewPath(view.id), view, { lock: null });
	}

	private viewPath(id: string): string {
		return join(this.viewsDir, `${id}.json`);
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.viewsDir, { recursive: true });
		return await lockedFileSystem.withLock({ type: "directory", path: this.filesDir }, operation);
	}
}

// Drop `undefined` patch keys so they don't clobber existing values via spread.
function definedFields<T extends object>(patch: T): Partial<T> {
	const result: Partial<T> = {};
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) {
			result[key as keyof T] = value as T[keyof T];
		}
	}
	return result;
}
