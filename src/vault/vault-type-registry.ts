import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getVaultTypesDir } from "./vault-paths";
import { VAULT_TYPE_SEEDS } from "./vault-type-seeds";
import { parseVaultTypeDefinition, serializeVaultTypeDefinition, type VaultTypeDefinition } from "./vault-types";

const DOC_EXTENSION = ".md";

/**
 * Scan a `_types/` directory, parsing each `.md` into a {@link VaultTypeDefinition}.
 * A torn or hand-broken file is silently skipped (crash tolerance), exactly like the
 * document store's scan — one bad type definition never hides the rest.
 */
export async function scanVaultTypeDefinitions(typesDir: string): Promise<VaultTypeDefinition[]> {
	const filenames = await listMarkdownFiles(typesDir);
	const definitions: VaultTypeDefinition[] = [];
	for (const filename of filenames) {
		let raw: string;
		try {
			raw = await readFile(join(typesDir, filename), "utf8");
		} catch {
			continue;
		}
		try {
			definitions.push(parseVaultTypeDefinition(raw));
		} catch {
			// Unparseable type definition — skip it so one bad file never empties the registry.
		}
	}
	return definitions;
}

/**
 * Seed the built-in {@link VAULT_TYPE_SEEDS} into `typesDir` as `<type>.md` documents.
 * Idempotent: a pre-existing directory is left untouched (the seeds are the *initial*
 * contents, not an enforced baseline — a workspace may edit or remove types after).
 */
export async function seedVaultTypeDefinitions(typesDir: string): Promise<void> {
	if (await directoryExists(typesDir)) {
		return;
	}
	await mkdir(typesDir, { recursive: true });
	for (const seed of VAULT_TYPE_SEEDS) {
		const path = join(typesDir, `${seed.type}${DOC_EXTENSION}`);
		await lockedFileSystem.writeTextFileAtomic(path, serializeVaultTypeDefinition(seed), { lock: null });
	}
}

/**
 * Disk-backed, per-repo view of the vault's type definitions. Reads `docs/_types/`
 * lazily and caches the result in memory; lookups are permissive — an unknown type
 * resolves to `undefined`, matching the engine's type-agnostic stance.
 */
export class VaultTypeRegistry {
	private readonly typesDir: string;
	private cache: VaultTypeDefinition[] | null = null;

	constructor(repoPath: string) {
		this.typesDir = getVaultTypesDir(repoPath);
	}

	async list(): Promise<VaultTypeDefinition[]> {
		if (this.cache === null) {
			this.cache = await scanVaultTypeDefinitions(this.typesDir);
		}
		return this.cache;
	}

	async get(type: string): Promise<VaultTypeDefinition | undefined> {
		const definitions = await this.list();
		return definitions.find((definition) => definition.type === type);
	}

	/** Drop the in-memory cache so the next read re-scans disk (e.g. after a type edit). */
	invalidate(): void {
		this.cache = null;
	}

	/**
	 * Absolute path of the `_types/` file that declares `type` (matched on the parsed
	 * `name` frontmatter, not the filename, so a hand-named file is still located), or
	 * `null` when no file declares it. Used by {@link delete} and by an update that must
	 * rewrite the existing file in place rather than orphan a non-canonically-named one.
	 */
	async locate(type: string): Promise<string | null> {
		for (const filename of await listMarkdownFiles(this.typesDir)) {
			const path = join(this.typesDir, filename);
			let raw: string;
			try {
				raw = await readFile(path, "utf8");
			} catch {
				continue;
			}
			try {
				if (parseVaultTypeDefinition(raw).type === type) {
					return path;
				}
			} catch {
				// Unparseable file — cannot claim a type id, skip it.
			}
		}
		return null;
	}

	/**
	 * Write a type definition to disk as a canonical `_types/<type>.md` document, always
	 * through {@link serializeVaultTypeDefinition} so a CLI write is byte-identical to a
	 * hand-authored file and round-trips (relations included). Pass `targetPath` to rewrite
	 * an existing, non-canonically-named file in place. Invalidates the cache after writing.
	 */
	async writeDefinition(definition: VaultTypeDefinition, targetPath?: string): Promise<void> {
		await mkdir(this.typesDir, { recursive: true });
		const path = targetPath ?? join(this.typesDir, `${definition.type}${DOC_EXTENSION}`);
		await lockedFileSystem.writeTextFileAtomic(path, serializeVaultTypeDefinition(definition), { lock: null });
		this.invalidate();
	}

	/** Remove the file declaring `type`. Returns `false` when no such file exists. */
	async delete(type: string): Promise<boolean> {
		const path = await this.locate(type);
		if (!path) {
			return false;
		}
		await rm(path, { force: true });
		this.invalidate();
		return true;
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

async function directoryExists(dir: string): Promise<boolean> {
	try {
		await readdir(dir);
		return true;
	} catch (error) {
		if (isNotFound(error)) {
			return false;
		}
		throw error;
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
