import { chmod, readFile } from "node:fs/promises";

import { createLogger } from "../logging";
import { lockedFileSystem } from "../fs/locked-file-system";
import { readShardDir, writeShardDir } from "../state/sharded-json-store";
import {
	type StorageConnectionRecord,
	type StorageCredential,
	type StorageCredentialsData,
	storageConnectionRecordSchema,
	storageCredentialsDataSchema,
} from "./storage-connection-record";

export type {
	StorageConnectionRecord,
	StorageCredential,
	StorageCredentialsData,
} from "./storage-connection-record";

const log = createLogger("storage:connection-store");

/** Fully-resolved, explicit options for constructing a bucket-scoped S3 client. */
export interface ResolvedS3ClientOptions {
	bucket: string;
	endpoint?: string;
	region?: string;
	virtualHostedStyle: boolean;
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
}

/** The id used to address a connection (its normalized id) — also the shard filename. */
export function normalizeConnId(id: string): string {
	return id.trim().toLowerCase();
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Read + assemble all committed connection records from their per-id shards. */
export async function readStorageConnections(shardDir: string): Promise<StorageConnectionRecord[]> {
	const shardMap = await readShardDir(shardDir, storageConnectionRecordSchema);
	return [...shardMap.values()];
}

/** Persist connection records: one shard per canonical `connId`. Absent shards are deleted. */
export async function writeStorageConnections(shardDir: string, records: StorageConnectionRecord[]): Promise<void> {
	const shardMap = new Map<string, StorageConnectionRecord>(
		records.map((r) => {
			const id = normalizeConnId(r.connId);
			return [id, { ...r, connId: id }];
		}),
	);
	await writeShardDir(shardDir, shardMap);
}

/** Read the machine-home credentials file. Missing/torn file ⇒ empty credentials. */
export async function readStorageCredentials(path: string): Promise<StorageCredentialsData> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = storageCredentialsDataSchema.safeParse(JSON.parse(raw) as unknown);
		return parsed.success ? parsed.data : { credentials: {} };
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to read storage credentials file; treating as empty", { error });
		}
		return { credentials: {} };
	}
}

/** Persist the machine-home credentials file (machine-local; no repo lock; owner-only 0600). */
export async function writeStorageCredentials(path: string, data: StorageCredentialsData): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, data, { lock: null });
	try {
		await chmod(path, 0o600);
	} catch (error) {
		log.warn("failed to restrict storage credentials file permissions", { error });
	}
}

/**
 * Merge committed metadata + the machine-home secret into explicit S3 client options.
 * The secret exists only in the returned in-memory object — it is never written to committed data,
 * and we always pass explicit values so Bun never falls back to `S3_*`/`AWS_*` env vars.
 */
export function resolveS3ClientOptions(
	record: StorageConnectionRecord,
	credential: StorageCredential | undefined,
): ResolvedS3ClientOptions {
	return {
		bucket: record.bucket,
		endpoint: record.endpoint ?? undefined,
		region: record.region ?? undefined,
		virtualHostedStyle: record.virtualHostedStyle,
		accessKeyId: credential?.accessKeyId,
		secretAccessKey: credential?.secretAccessKey,
		sessionToken: credential?.sessionToken,
	};
}
