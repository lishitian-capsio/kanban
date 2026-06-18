import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { lockedFileSystem } from "../fs/locked-file-system";
import { KANBAN_RUNTIME_HOME_DIR_NAME } from "../workspace/task-worktree-path";

/**
 * The board-branch pointer file. It lives in the **code tree's** `.kanban` and is
 * the single tracked artifact that survives a clone (everything else under
 * `.kanban` is gitignored once decoupling is active). Its presence is the gate
 * that flips committed board data into the board worktree; its `branch` field is
 * the authoritative discovery source for which branch holds that data. See
 * `.plan/docs/board-branch-decoupling.md` §3.5.
 */
export const BOARD_REF_FILENAME = "board-ref";

/** Schema version of the pointer document; bumped only on a breaking shape change. */
export const BOARD_REF_VERSION = 1;

/** Default branch that holds the decoupled board data (orphan, never merged). */
export const DEFAULT_BOARD_BRANCH = "kanban/board";

export const boardRefSchema = z.object({
	version: z.number().int().positive(),
	branch: z.string().min(1),
});

export type BoardRef = z.infer<typeof boardRefSchema>;

/** Absolute path of the pointer file: `<repo>/.kanban/board-ref`. */
export function getBoardRefPath(repoPath: string): string {
	return join(repoPath, KANBAN_RUNTIME_HOME_DIR_NAME, BOARD_REF_FILENAME);
}

/**
 * Synchronous gate: has board-branch decoupling been activated for this repo?
 *
 * Resolved by the mere presence of the pointer file so {@link
 * import("./workspace-state").resolveBoardDataLocation} can stay synchronous —
 * it is consulted on every committed-data path derivation. The branch name is
 * only needed for git operations, so it is read lazily via {@link readBoardRef}.
 */
export function isBoardDecouplingActive(repoPath: string): boolean {
	return existsSync(getBoardRefPath(repoPath));
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

/** Read and validate the pointer; returns `null` when it does not exist. */
export async function readBoardRef(repoPath: string): Promise<BoardRef | null> {
	const path = getBoardRefPath(repoPath);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		throw error;
	}

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Malformed board-ref JSON at ${path}. ${message}`);
	}

	const parsed = boardRefSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error(`Invalid board-ref at ${path}. ${parsed.error.message}`);
	}
	return parsed.data;
}

/** Atomically write the pointer file (validated against {@link boardRefSchema}). */
export async function writeBoardRef(repoPath: string, ref: BoardRef): Promise<void> {
	const parsed = boardRefSchema.parse(ref);
	await lockedFileSystem.writeJsonFileAtomic(getBoardRefPath(repoPath), parsed);
}
