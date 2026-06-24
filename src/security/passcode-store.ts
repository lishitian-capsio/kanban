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
	value: z.string().optional(),
	issuedAt: z.number().optional(),
	/**
	 * `true` when the operator explicitly disabled passcode auth via
	 * `kanban remote passcode disable` (the persisted `--no-passcode` equivalent).
	 * A disabled record carries no `value`.
	 */
	disabled: z.boolean().optional(),
});

type PersistedPasscode = z.infer<typeof persistedPasscodeSchema>;

/** The persisted passcode state as seen from disk. */
export interface PersistedPasscodeRecord {
	/** The persisted passcode value, or `null` when none is set / it is disabled. */
	value: string | null;
	/** Whether passcode auth was explicitly disabled and persisted. */
	disabled: boolean;
}

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

/**
 * Read the full persisted passcode state. Missing/torn/invalid file ⇒
 * `{ value: null, disabled: false }`. A disabled record reports `value: null`
 * (a disable persists no secret).
 */
export async function readPersistedPasscodeRecord(path: string): Promise<PersistedPasscodeRecord> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = persistedPasscodeSchema.safeParse(JSON.parse(raw) as unknown);
		if (!parsed.success) return { value: null, disabled: false };
		const disabled = parsed.data.disabled === true;
		if (disabled) {
			return { value: null, disabled: true };
		}
		const value = parsed.data.value?.trim() ?? "";
		return { value: value.length > 0 ? value : null, disabled: false };
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to read persisted passcode; treating as absent", { error });
		}
		return { value: null, disabled: false };
	}
}

/** Read the persisted passcode value. Missing/torn/invalid/disabled ⇒ `null`. */
export async function readPersistedPasscode(path: string): Promise<string | null> {
	return (await readPersistedPasscodeRecord(path)).value;
}

/** Whether passcode auth was explicitly disabled and persisted (the `--no-passcode` equivalent). */
export async function isPersistedPasscodeDisabled(path: string): Promise<boolean> {
	return (await readPersistedPasscodeRecord(path)).disabled;
}

/** Persist the passcode (machine-local secret; owner-only perms, no repo lock). */
export async function writePersistedPasscode(path: string, value: string): Promise<void> {
	// Writing a value clears any prior `disabled` marker (the whole file is replaced).
	const payload: PersistedPasscode = { value, issuedAt: Date.now() };
	await lockedFileSystem.writeJsonFileAtomic(path, payload, { lock: null });
	try {
		await chmod(path, 0o600);
	} catch (error) {
		log.warn("failed to restrict passcode file permissions", { error });
	}
}

/**
 * Persist the explicit-disable state (`kanban remote passcode disable`). This is the
 * persisted `--no-passcode` equivalent: a subsequent remote launch with no overriding
 * `--passcode`/`KANBAN_PASSCODE` keeps passcode auth off without re-passing the flag.
 * No secret is written.
 */
export async function disablePersistedPasscode(path: string): Promise<void> {
	const payload: PersistedPasscode = { disabled: true, issuedAt: Date.now() };
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
