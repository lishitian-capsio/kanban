import { readFile } from "node:fs/promises";

import { createLogger } from "../../logging";
import { lockedFileSystem } from "../../fs/locked-file-system";
import { readShardDir, writeShardDir } from "../../state/sharded-json-store";
import type { ConnectionConfig } from "../types";
import {
	type ConnectionRecord,
	type DbCredential,
	type DbCredentialsData,
	connectionRecordSchema,
	dbCredentialsDataSchema,
} from "./connection-record";

export type { ConnectionRecord, DbCredential, DbCredentialsData };

const log = createLogger("db:connection-store");

/** The id used to address a connection (its normalized id) — also the shard filename. */
export function normalizeConnId(id: string): string {
	return id.trim().toLowerCase();
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Read + assemble all committed connection records from their per-id shards. */
export async function readConnections(shardDir: string): Promise<ConnectionRecord[]> {
	const shardMap = await readShardDir(shardDir, connectionRecordSchema);
	return [...shardMap.values()];
}

/**
 * Persist connection records: one shard per `connId`.
 * Canonicalizes connIds (trim + lowercase) so the shard filename, the stored `connId` field,
 * and any lookup key are always in sync. Shards absent from `records` are deleted.
 */
export async function writeConnections(shardDir: string, records: ConnectionRecord[]): Promise<void> {
	const shardMap = new Map<string, ConnectionRecord>(
		records.map((r) => {
			const id = normalizeConnId(r.connId);
			return [id, { ...r, connId: id }];
		}),
	);
	await writeShardDir(shardDir, shardMap);
}

/** Read the machine-home credentials file. Missing/torn file ⇒ empty credentials. */
export async function readCredentials(path: string): Promise<DbCredentialsData> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = dbCredentialsDataSchema.safeParse(JSON.parse(raw) as unknown);
		return parsed.success ? parsed.data : { credentials: {} };
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to read credentials file; treating as empty", { error });
		}
		return { credentials: {} };
	}
}

/** Persist the machine-home credentials file (machine-local; no repo lock). */
export async function writeCredentials(path: string, data: DbCredentialsData): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, data, { lock: null });
}

/**
 * Merge committed metadata + the machine-home secret into a full {@link ConnectionConfig}.
 * The secret exists only in the returned in-memory object — it is never written to committed data.
 */
export function resolveConnectionConfig(
	record: ConnectionRecord,
	credential: DbCredential | undefined,
): ConnectionConfig {
	return {
		engine: record.engine,
		host: record.host ?? undefined,
		port: record.port ?? undefined,
		database: record.database ?? undefined,
		user: record.user ?? undefined,
		filePath: record.filePath ?? undefined,
		ssl: record.ssl ?? undefined,
		password: credential?.password,
		sslKeyPem: credential?.sslKeyPem,
		sslCertPem: credential?.sslCertPem,
	};
}
