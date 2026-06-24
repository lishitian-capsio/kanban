/**
 * Persistence for the remote-access passcode.
 *
 * The passcode is a secret, so it follows the machine-home secrets convention
 * (`~/.kanban/settings/passcode.json`, same place as `db-credentials.json`):
 * it lives outside any repository checkout and is therefore never committed.
 * Persisting it lets the runtime REUSE the same passcode across restarts
 * (so an OS service restart, `Restart=on-failure`, etc. no longer silently
 * rotates the passcode and invalidates every shared link and logged-in session).
 *
 * The disk file is written with owner-only (`0o600`) permissions.
 */

import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { getMachineKanbanHomePath } from "../state/workspace-state";
import { generateRandomPasscode } from "./passcode-manager";
import { type ResolvedPasscode, resolvePasscode } from "./passcode-resolver";

const log = createLogger("security.passcode-store");

const persistedPasscodeSchema = z.object({
	value: z.string(),
	issuedAt: z.number().optional(),
});

type PersistedPasscode = z.infer<typeof persistedPasscodeSchema>;

/**
 * Absolute path to the persisted passcode file. Honors `KANBAN_PASSCODE_FILE`
 * (mirrors `KANBAN_DB_CREDENTIALS_PATH`); otherwise machine-home `settings/`.
 */
export function getPasscodeFilePath(): string {
	const override = process.env.KANBAN_PASSCODE_FILE?.trim();
	if (override) {
		return override;
	}
	return join(getMachineKanbanHomePath(), "settings", "passcode.json");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Read the persisted passcode value. Missing/torn/invalid file ⇒ `null`. */
export async function readPersistedPasscode(path: string): Promise<string | null> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = persistedPasscodeSchema.safeParse(JSON.parse(raw) as unknown);
		if (!parsed.success) return null;
		const value = parsed.data.value.trim();
		return value.length > 0 ? value : null;
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to read persisted passcode; treating as absent", { error });
		}
		return null;
	}
}

/** Persist the passcode (machine-local secret; owner-only perms, no repo lock). */
export async function writePersistedPasscode(path: string, value: string): Promise<void> {
	const payload: PersistedPasscode = { value, issuedAt: Date.now() };
	await lockedFileSystem.writeJsonFileAtomic(path, payload, { lock: null });
	try {
		await chmod(path, 0o600);
	} catch (error) {
		log.warn("failed to restrict passcode file permissions", { error });
	}
}

export interface ResolveAndPersistPasscodeOptions {
	/** Explicit passcode from `--passcode` / `KANBAN_PASSCODE`. `null`/blank ⇒ none. */
	explicit: string | null;
	/** Override the persisted-file path (tests). Defaults to {@link getPasscodeFilePath}. */
	filePath?: string;
	/** Override the random generator (tests). Defaults to the manager's CSPRNG generator. */
	generate?: () => string;
}

/**
 * Resolve the effective passcode (explicit > persisted > generated) and write it
 * back to disk unless it was already the persisted value. Returns the resolved
 * value and which source won. Does NOT touch the in-memory passcode manager —
 * the caller wires the result into the manager via `setPasscode`.
 */
export async function resolveAndPersistPasscode(options: ResolveAndPersistPasscodeOptions): Promise<ResolvedPasscode> {
	const filePath = options.filePath ?? getPasscodeFilePath();
	const persisted = await readPersistedPasscode(filePath);
	const resolved = resolvePasscode({
		explicit: options.explicit,
		persisted,
		generate: options.generate ?? generateRandomPasscode,
	});
	if (resolved.source !== "persisted") {
		await writePersistedPasscode(filePath, resolved.value);
	}
	return resolved;
}
