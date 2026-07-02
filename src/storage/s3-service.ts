// src/storage/s3-service.ts
import { Buffer } from "node:buffer";

import { createLogger } from "../logging";
import type { S3ClientFactory, S3ClientLike } from "./s3-client";
import { classifyContent, mapListResponse, basename, type StorageEntry } from "./storage-object-mapping";
import { resolveS3ClientOptions } from "./storage-connection-store";
import type { StorageConnectionRecord, StorageCredential } from "./storage-connection-record";

const log = createLogger("storage:service");

export const STORAGE_TEXT_MAX_BYTES = 1_048_576;
export const STORAGE_PREVIEW_MAX_BYTES = 8_388_608;
export const STORAGE_DOWNLOAD_MAX_BYTES = 104_857_600;

export interface StorageServiceDeps {
	createClient: S3ClientFactory;
	loadConnection: (connId: string) => Promise<StorageConnectionRecord | null>;
	loadCredential: (connId: string) => Promise<StorageCredential | undefined>;
}

export interface ListObjectsInput {
	prefix?: string;
	continuationToken?: string;
	maxKeys?: number;
}

export interface StorageObjectContent {
	key: string;
	encoding: "utf8" | "base64";
	content: string | null;
	size: number;
	lastModified: string;
	etag: string;
	contentType: string;
	binary: boolean;
	tooLarge: boolean;
}

/**
 * Read-only object-storage service. Mirrors DatabaseService's injected-deps shape. It deliberately
 * exposes NO write/delete/presign method — read-only is structural, not a runtime policy check.
 */
export class StorageService {
	constructor(private readonly deps: StorageServiceDeps) {}

	private async client(connId: string): Promise<S3ClientLike> {
		const record = await this.deps.loadConnection(connId);
		if (!record) {
			throw new Error(`Unknown storage connection "${connId}".`);
		}
		const credential = await this.deps.loadCredential(connId);
		return this.deps.createClient(resolveS3ClientOptions(record, credential));
	}

	async testConnection(connId: string): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
		const started = performance.now();
		try {
			const client = await this.client(connId);
			await client.list({ maxKeys: 1 });
			return { ok: true, latencyMs: Math.round(performance.now() - started), error: null };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, latencyMs: Math.round(performance.now() - started), error: message };
		}
	}

	async listObjects(
		connId: string,
		input: ListObjectsInput,
	): Promise<{ prefix: string; entries: StorageEntry[]; isTruncated: boolean; nextContinuationToken?: string }> {
		const prefix = input.prefix ?? "";
		const client = await this.client(connId);
		const res = await client.list({
			prefix,
			delimiter: "/",
			maxKeys: input.maxKeys ?? 1000,
			continuationToken: input.continuationToken,
		});
		const mapped = mapListResponse(prefix, res);
		return { prefix, ...mapped };
	}

	async statObject(
		connId: string,
		key: string,
	): Promise<{ key: string; size: number; lastModified: string; etag: string; contentType: string }> {
		const client = await this.client(connId);
		const stat = await client.stat(key);
		return {
			key,
			size: stat.size,
			lastModified: stat.lastModified.toISOString(),
			etag: stat.etag,
			contentType: stat.type,
		};
	}

	async readObject(connId: string, key: string): Promise<StorageObjectContent> {
		const client = await this.client(connId);
		const stat = await client.stat(key);
		const base = {
			key,
			size: stat.size,
			lastModified: stat.lastModified.toISOString(),
			etag: stat.etag,
			contentType: stat.type,
		};
		// Pre-classify using content-type + key extension only (empty bytes → no NUL heuristic).
		const pre = classifyContent(new Uint8Array(), stat.type, key);
		const cap = pre.binary ? STORAGE_PREVIEW_MAX_BYTES : STORAGE_TEXT_MAX_BYTES;
		// Short-circuit: avoid any network read when the object is already known to exceed the cap.
		if (stat.size > cap) {
			return { ...base, encoding: pre.binary ? "base64" : "utf8", content: null, binary: pre.binary, tooLarge: true };
		}
		// Read only up to the type-appropriate cap (never more than needed).
		const { bytes, contentType } = await client.readBytes(key, cap);
		// Authoritative classification from real bytes wins for the returned value.
		const { binary } = classifyContent(bytes, contentType || stat.type, key);
		if (binary) {
			return { ...base, encoding: "base64", content: Buffer.from(bytes).toString("base64"), binary, tooLarge: false };
		}
		return { ...base, encoding: "utf8", content: new TextDecoder().decode(bytes), binary, tooLarge: false };
	}

	async downloadObject(
		connId: string,
		key: string,
	): Promise<{ fileName: string; contentType: string; data: string | null; tooLarge: boolean }> {
		const client = await this.client(connId);
		const stat = await client.stat(key);
		if (stat.size > STORAGE_DOWNLOAD_MAX_BYTES) {
			return { fileName: basename(key), contentType: stat.type, data: null, tooLarge: true };
		}
		const { bytes, contentType } = await client.readBytes(key, STORAGE_DOWNLOAD_MAX_BYTES);
		log.debug("downloaded storage object", { connId, key, size: bytes.byteLength });
		return { fileName: basename(key), contentType: contentType || stat.type, data: Buffer.from(bytes).toString("base64"), tooLarge: false };
	}
}
