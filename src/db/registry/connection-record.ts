import { z } from "zod";

export const databaseEngineSchema = z.enum(["postgres", "mysql", "sqlite"]);

export const dbSslConfigSchema = z.object({
	mode: z.enum(["disable", "require", "verify-ca", "verify-full"]),
	caPath: z.string().optional(),
});

/**
 * Committed, secret-free connection metadata. Sharded one-file-per-`connId` under the
 * board-data home so cross-branch edits never collide. NEVER carries a password or key.
 */
export const connectionRecordSchema = z.object({
	connId: z.string().min(1),
	label: z.string().min(1),
	engine: databaseEngineSchema,
	host: z.string().nullable(),
	port: z.number().int().positive().nullable(),
	database: z.string().nullable(),
	user: z.string().nullable(),
	filePath: z.string().nullable(),
	ssl: dbSslConfigSchema.nullable(),
	/** Connection-level write opt-in. Default false ⇒ the connection is read-only. */
	allowWrites: z.boolean().default(false),
	/** ISO timestamp; supplied by the caller (no Date.now() in stored/pure code). */
	createdAt: z.string(),
});
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>;

/** Machine-home secret for one connection. Lives ONLY in ~/.kanban, never committed. */
export const dbCredentialSchema = z.object({
	password: z.string().optional(),
	sslKeyPem: z.string().optional(),
	sslCertPem: z.string().optional(),
});
export type DbCredential = z.infer<typeof dbCredentialSchema>;

export const dbCredentialsDataSchema = z.object({
	credentials: z.record(z.string(), dbCredentialSchema).default({}),
});
export type DbCredentialsData = z.infer<typeof dbCredentialsDataSchema>;
