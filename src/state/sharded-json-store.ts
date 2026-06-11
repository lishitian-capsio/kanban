import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";

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
	const result = new Map<string, T>();
	for (const id of await listShardIds(dir)) {
		const filePath = shardFilePath(dir, id);
		const raw = await readFile(filePath, "utf8");
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
		result.set(id, validated.data);
	}
	return result;
}

/**
 * Persist `shards` (id -> value) into `dir` so the directory mirrors the map
 * exactly: each entry is written to `<id>.json` and any existing `<id>.json` whose
 * id is absent from the map is removed. Writes are atomic and skip files whose
 * content is unchanged (so git sees no spurious diff). Callers are expected to hold
 * the relevant workspace lock; the per-file writes pass `lock: null`.
 */
export async function writeShardDir<T>(dir: string, shards: Map<string, T>): Promise<void> {
	for (const [id, value] of shards) {
		await lockedFileSystem.writeJsonFileAtomic(shardFilePath(dir, id), value, { lock: null });
	}
	for (const existingId of await listShardIds(dir)) {
		if (!shards.has(existingId)) {
			await rm(shardFilePath(dir, existingId), { force: true });
		}
	}
}
