/**
 * Persistence for the internal CLI auth token.
 *
 * The internal token is the bearer secret CLI sub-processes (hooks ingest, task
 * commands) use to authenticate against a remote-bound runtime without the
 * browser passcode flow. Like the passcode it is a machine-local secret and
 * follows the same convention (`~/.kanban/settings/internal-token.json`, the
 * same place as `passcode.json` / `db-credentials.json`): it lives outside any
 * repository checkout and is therefore never committed.
 *
 * Persisting it lets the runtime REUSE the same token across restarts. Without
 * persistence the token was regenerated on every start, so an OS-service
 * restart silently rotated it — invalidating the tokens that still-running
 * agent sessions (spawned by the previous instance) carry, and locking out any
 * CLI/hook process launched independently of the daemon. Mirrors
 * {@link ../security/passcode-store}.
 *
 * The disk file is written with owner-only (`0o600`) permissions.
 */

import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { getMachineKanbanHomePath } from "../state/workspace-state";
import { generateRandomInternalToken } from "./passcode-manager";

const log = createLogger("security.internal-token-store");

const persistedInternalTokenSchema = z.object({
	value: z.string().optional(),
	issuedAt: z.number().optional(),
});

type PersistedInternalToken = z.infer<typeof persistedInternalTokenSchema>;

/**
 * Absolute path to the persisted internal-token file. Honors
 * `KANBAN_INTERNAL_TOKEN_FILE` (mirrors `KANBAN_PASSCODE_FILE`); otherwise
 * machine-home `settings/`.
 */
export function getInternalTokenFilePath(): string {
	const override = process.env.KANBAN_INTERNAL_TOKEN_FILE?.trim();
	if (override) {
		return override;
	}
	return join(getMachineKanbanHomePath(), "settings", "internal-token.json");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Read the persisted internal token. Missing/torn/invalid file ⇒ `null`. */
export async function readPersistedInternalToken(path: string): Promise<string | null> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = persistedInternalTokenSchema.safeParse(JSON.parse(raw) as unknown);
		if (!parsed.success) return null;
		const value = parsed.data.value?.trim() ?? "";
		return value.length > 0 ? value : null;
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to read persisted internal token; treating as absent", { error });
		}
		return null;
	}
}

/** Persist the internal token (machine-local secret; owner-only perms, no repo lock). */
export async function writePersistedInternalToken(path: string, value: string): Promise<void> {
	const payload: PersistedInternalToken = { value, issuedAt: Date.now() };
	await lockedFileSystem.writeJsonFileAtomic(path, payload, { lock: null });
	try {
		await chmod(path, 0o600);
	} catch (error) {
		log.warn("failed to restrict internal token file permissions", { error });
	}
}

export interface ResolveAndPersistInternalTokenOptions {
	/** Override the persisted-file path (tests). Defaults to {@link getInternalTokenFilePath}. */
	filePath?: string;
	/** Override the random generator (tests). Defaults to the manager's CSPRNG generator. */
	generate?: () => string;
}

/** Where the resolved internal token came from. */
export interface ResolvedInternalToken {
	value: string;
	source: "persisted" | "generated";
}

/**
 * Resolve the effective internal token (persisted > generated) and write it back
 * to disk when newly generated. Returns the resolved value and which source won.
 * Does NOT touch the in-memory passcode manager — the caller wires the result in
 * via `setInternalToken`. Unlike the passcode there is no "explicit" source: the
 * internal token is never operator-set, only generated-and-reused.
 */
export async function resolveAndPersistInternalToken(
	options: ResolveAndPersistInternalTokenOptions = {},
): Promise<ResolvedInternalToken> {
	const filePath = options.filePath ?? getInternalTokenFilePath();
	const persisted = await readPersistedInternalToken(filePath);
	if (persisted !== null) {
		return { value: persisted, source: "persisted" };
	}
	const value = (options.generate ?? generateRandomInternalToken)();
	await writePersistedInternalToken(filePath, value);
	return { value, source: "generated" };
}
