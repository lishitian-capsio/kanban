import { z } from "zod";

/**
 * Committed, secret-free connection metadata. Sharded one-file-per-`connId` under the
 * board-data home so cross-branch edits never collide. NEVER carries credentials.
 * A connection is scoped to ONE bucket — `Bun.S3Client` is bucket-scoped and exposes no
 * ListBuckets, so we do not enumerate buckets.
 */
export const storageConnectionRecordSchema = z.object({
	connId: z.string().min(1),
	label: z.string().min(1),
	/** Custom S3-compatible endpoint (R2/MinIO/Spaces/Supabase); null ⇒ AWS default. */
	endpoint: z.string().nullable(),
	region: z.string().nullable(),
	bucket: z.string().min(1),
	/** false ⇒ path-style addressing (MinIO); true ⇒ virtual-hosted. Default false. */
	virtualHostedStyle: z.boolean().default(false),
	/** ISO timestamp; supplied by the caller (no Date.now() in stored/pure code). */
	createdAt: z.string(),
});
export type StorageConnectionRecord = z.infer<typeof storageConnectionRecordSchema>;

/** Machine-home secret for one connection. Lives ONLY in ~/.kanban, never committed. */
export const storageCredentialSchema = z.object({
	accessKeyId: z.string().optional(),
	secretAccessKey: z.string().optional(),
	sessionToken: z.string().optional(),
});
export type StorageCredential = z.infer<typeof storageCredentialSchema>;

export const storageCredentialsDataSchema = z.object({
	credentials: z.record(z.string(), storageCredentialSchema).default({}),
});
export type StorageCredentialsData = z.infer<typeof storageCredentialsDataSchema>;
