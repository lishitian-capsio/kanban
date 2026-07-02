import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";

import { readTextFile } from "../fs/fast-file";
import { mapFilesConcurrent } from "../fs/concurrent-files";
import { lockedFileSystem } from "../fs/locked-file-system";

const SHARD_EXTENSION = ".json";

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function shardIdFromFilename(filename: string): string {
	return filename.slice(0, -SHARD_EXTENSION.length);
}

function shardFilePath(dir: string, id: string): string {
	return join(dir, `${id}${SHARD_EXTENSION}`);
}

function formatSchemaIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length === 0 ? "root" : issue.path.join(".");
			return `${path}: ${issue.message}`;
		})
		.join("; ");
}

/** List the shard ids currently present on disk (`*.json` files only). */
async function listShardIds(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(SHARD_EXTENSION))
			.map((entry) => shardIdFromFilename(entry.name));
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return [];
		}
		throw error;
	}
}

/**
 * Read every `<id>.json` shard in `dir` into a `Map` keyed by id (filename minus
 * the `.json` extension), validating each against `schema`. A missing directory
 * yields an empty map; non-`.json` files and subdirectories are ignored. A shard
 * that fails validation throws with the offending file path so the bad file is
 * easy to locate and fix.
 */
export async function readShardDir<T>(
	dir: string,
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<Map<string, T>> {
	const ids = await listShardIds(dir);
	const entries = await mapFilesConcurrent(ids, async (id): Promise<[string, T]> => {
		const filePath = shardFilePath(dir, id);
		const raw = await readTextFile(filePath);
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(raw) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Malformed JSON in shard ${filePath}. ${message}`);
		}
		const validated = schema.safeParse(parsedJson);
		if (!validated.success) {
			throw new Error(`Invalid shard ${filePath}. ${formatSchemaIssues(validated.error)}`);
		}
		return [id, validated.data];
	});
	return new Map(entries);
}

/**
 * Persist `shards` (id -> value) into `dir` so the directory mirrors the map
 * exactly: each entry is written to `<id>.json` and any existing `<id>.json` whose
 * id is absent from the map is removed. Writes are atomic and skip files whose
 * content is unchanged (so git sees no spurious diff). Callers are expected to hold
 * the relevant workspace lock; the per-file writes pass `lock: null`.
 */
export async function writeShardDir<T>(dir: string, shards: Map<string, T>): Promise<void> {
	// List existing shards before writing so the delete pass reuses this result
	// instead of re-reading the directory; new `<id>.json` files written below are
	// (correctly) absent from it, so only pre-existing ids missing from the map are removed.
	const existingIds = await listShardIds(dir);
	const operations: Array<() => Promise<unknown>> = [
		...[...shards].map(
			([id, value]) =>
				() =>
					lockedFileSystem.writeJsonFileAtomic(shardFilePath(dir, id), value, { lock: null }),
		),
		...existingIds
			.filter((existingId) => !shards.has(existingId))
			.map((existingId) => () => rm(shardFilePath(dir, existingId), { force: true })),
	];
	await mapFilesConcurrent(operations, (operation) => operation());
}
