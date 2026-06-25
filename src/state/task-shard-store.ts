import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
	type RuntimeBoardCard,
	type RuntimeBoardColumn,
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	type RuntimeBoardDependency,
	runtimeBoardCardObjectSchema,
	runtimeBoardColumnIdSchema,
	runtimeBoardDataSchema,
} from "../core/api-contract";
import { resolveTaskTitle } from "../core/task-title";
import { mapFilesConcurrent } from "../fs/concurrent-files";
import { lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { reconcileColumnRanks } from "./task-rank";

const log = createLogger("task-shard-store");

const TASKS_DIRNAME = "tasks";
const BOARD_MANIFEST_FILENAME = "board.json";
const BOARD_MANIFEST_VERSION = 1;

/**
 * The fixed Kanban columns. Canonical default used both for a fresh board and as
 * the fallback layout when a workspace has no `board.json` manifest yet. Lives here
 * (not in workspace-state) so the shard store stays free of an import cycle.
 */
export const DEFAULT_BOARD_COLUMNS: ReadonlyArray<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "trash", title: "Done" },
];

/** A dependency edge as stored on its from-task file (fromTaskId is implicit). */
const storedTaskDependencySchema = z.object({
	id: z.string(),
	toTaskId: z.string(),
	createdAt: z.number(),
});

/** The durable task spec plus storage-only fields, one of these per `tasks/<id>.json`. */
const storedTaskSchema = runtimeBoardCardObjectSchema.extend({
	column: runtimeBoardColumnIdSchema,
	rank: z.string(),
	dependsOn: z.array(storedTaskDependencySchema).default([]),
});
type StoredTask = z.infer<typeof storedTaskSchema>;

const boardManifestSchema = z.object({
	version: z.literal(BOARD_MANIFEST_VERSION).optional(),
	columns: z.array(z.object({ id: runtimeBoardColumnIdSchema, title: z.string() })),
});

function boardManifestPath(boardDir: string): string {
	return join(boardDir, BOARD_MANIFEST_FILENAME);
}

function tasksDirPath(boardDir: string): string {
	return join(boardDir, TASKS_DIRNAME);
}

function taskFilePath(boardDir: string, taskId: string): string {
	return join(tasksDirPath(boardDir), `${taskId}.json`);
}

function formatBoardIssues(error: z.ZodError): string {
	return error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
}

/**
 * Validate a legacy single-file / migration-source board, failing loudly with a
 * `board.json`-labeled message (the same contract the pre-shard read path had) so a
 * hand-corrupted board surfaces a clear, actionable error instead of a raw ZodError.
 */
function parseBoardDataOrThrow(raw: unknown, sourcePath: string): RuntimeBoardData {
	const parsed = runtimeBoardDataSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`Invalid ${BOARD_MANIFEST_FILENAME} file at ${sourcePath}. ` +
				`Fix or remove the file. Validation errors: ${formatBoardIssues(parsed.error)}`,
		);
	}
	return parsed.data;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return false;
		}
		throw error;
	}
}

async function readJson(path: string): Promise<unknown | null> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			return JSON.parse(raw) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Malformed JSON in ${path}. ${message}`);
		}
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return null;
		}
		throw error;
	}
}

/**
 * An "old shape" board is the legacy single-file board: `{ columns: [{ cards }] }`.
 * The sharded layout manifest never carries `cards`, so the presence of a `cards`
 * key on any column is the unambiguous, idempotent migration signal.
 */
function isOldShapeBoard(raw: unknown | null): boolean {
	if (typeof raw !== "object" || raw === null) {
		return false;
	}
	const columns = (raw as { columns?: unknown }).columns;
	if (!Array.isArray(columns)) {
		return false;
	}
	return columns.some((column) => typeof column === "object" && column !== null && "cards" in column);
}

async function boardDirHasData(boardDir: string): Promise<boolean> {
	return (await pathExists(boardManifestPath(boardDir))) || (await pathExists(tasksDirPath(boardDir)));
}

/**
 * Pick the directory to read from: the primary repo-rooted dir when it already has
 * data, otherwise the legacy machine-rooted dir (`~/.kanban/...`) as a read
 * fallback, otherwise the primary dir (empty/default). Writes always target the
 * primary dir; the legacy source is never mutated.
 */
async function resolveSourceDir(boardDir: string, legacyBoardDir?: string): Promise<string> {
	if (await boardDirHasData(boardDir)) {
		return boardDir;
	}
	if (legacyBoardDir && (await boardDirHasData(legacyBoardDir))) {
		return legacyBoardDir;
	}
	return boardDir;
}

async function listTaskFileIds(tasksDir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(tasksDir);
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return [];
		}
		throw error;
	}
	return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
}

async function readStoredTasks(boardDir: string): Promise<StoredTask[]> {
	const ids = await listTaskFileIds(tasksDirPath(boardDir));
	// Read every shard concurrently — N serial reads dominated board-load latency
	// (~0.48s for ~150 shards). Bounded by the shared file-concurrency budget so a
	// board with thousands of tasks can't open thousands of fds at once (EMFILE).
	// Stable ordering is restored downstream by the rank sort in assembleBoard, so
	// the parallel read order is irrelevant.
	const rawShards = await mapFilesConcurrent(ids, async (id) => {
		try {
			return await readJson(taskFilePath(boardDir, id));
		} catch (error) {
			// A shard truncated/garbled by a crash mid-write has unparseable bytes, so
			// `readJson` throws. That MUST NOT sink the whole board read (it would make
			// the board unloadable and wedge every read-path consumer — the projects
			// payload, the snapshot, board-sync). Skip the one bad shard; its rank is
			// re-minted on the next save. Schema-invalid-but-parseable shards are handled
			// by the safeParse below.
			log.warn("skipping unreadable task shard", { taskId: id, error });
			return null;
		}
	});
	const tasks: StoredTask[] = [];
	for (const raw of rawShards) {
		if (raw === null) {
			continue;
		}
		const parsed = storedTaskSchema.safeParse(raw);
		// Tolerate a torn trailing file from a crash mid-write; the rank for a
		// skipped task is simply re-minted on the next save.
		if (parsed.success) {
			tasks.push(parsed.data);
		}
	}
	return tasks;
}

function readManifestColumns(rawManifest: unknown | null): Array<{ id: RuntimeBoardColumnId; title: string }> {
	if (rawManifest === null) {
		return DEFAULT_BOARD_COLUMNS.map((column) => ({ ...column }));
	}
	const parsed = boardManifestSchema.safeParse(rawManifest);
	if (!parsed.success || parsed.data.columns.length === 0) {
		return DEFAULT_BOARD_COLUMNS.map((column) => ({ ...column }));
	}
	return parsed.data.columns;
}

function assembleBoard(
	columns: Array<{ id: RuntimeBoardColumnId; title: string }>,
	storedTasks: StoredTask[],
): RuntimeBoardData {
	const tasksByColumn = new Map<RuntimeBoardColumnId, StoredTask[]>();
	const liveTaskIds = new Set<string>();
	for (const task of storedTasks) {
		liveTaskIds.add(task.id);
		const bucket = tasksByColumn.get(task.column);
		if (bucket) {
			bucket.push(task);
		} else {
			tasksByColumn.set(task.column, [task]);
		}
	}

	const dependencies: RuntimeBoardDependency[] = [];
	const assembledColumns: RuntimeBoardColumn[] = columns.map((column) => {
		const ordered = (tasksByColumn.get(column.id) ?? []).sort((a, b) =>
			a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0,
		);
		const cards: RuntimeBoardCard[] = ordered.map((task) => {
			for (const edge of task.dependsOn) {
				// Drop a dangling edge whose target task no longer exists on the board
				// (a torn/inconsistent shard set can leave one behind). The from-task is
				// always live here since we only walk live tasks' `dependsOn`. Emitting a
				// dangling edge would feed a half-real dependency graph to every direct
				// `loadShardedBoard` consumer (board-sync, board-worktree) that does not
				// run it back through `updateTaskDependencies`.
				if (!liveTaskIds.has(edge.toTaskId)) {
					continue;
				}
				dependencies.push({ id: edge.id, fromTaskId: task.id, toTaskId: edge.toTaskId, createdAt: edge.createdAt });
			}
			const { column: _column, rank: _rank, dependsOn: _dependsOn, ...cardFields } = task;
			// Each shard is already validated against storedTaskSchema, so the legacy
			// whole-board re-parse here was redundant work. The one piece it did that
			// shard validation does NOT is the runtimeBoardCardSchema title transform
			// (storedTaskSchema extends the object schema, sans transform) — apply it
			// directly so the assembled board is byte-for-byte identical.
			return { ...cardFields, title: resolveTaskTitle(cardFields.title, cardFields.prompt) };
		});
		return { id: column.id, title: column.title, cards };
	});

	return { columns: assembledColumns, dependencies };
}

/**
 * Read a board from its sharded on-disk form. Back-compatible: if the directory
 * still holds a legacy single-file `board.json` (cards inline), it is assembled
 * directly without writing anything. Non-destructive — disk conversion to shards
 * only happens on a write ({@link saveShardedBoard} / {@link convertBoardToShards}).
 */
export async function loadShardedBoard(boardDir: string, legacyBoardDir?: string): Promise<RuntimeBoardData> {
	const source = await resolveSourceDir(boardDir, legacyBoardDir);
	const rawManifest = await readJson(boardManifestPath(source));
	if (isOldShapeBoard(rawManifest)) {
		return parseBoardDataOrThrow(rawManifest, boardManifestPath(source));
	}
	const columns = readManifestColumns(rawManifest);
	const storedTasks = await readStoredTasks(source);
	return assembleBoard(columns, storedTasks);
}

/**
 * Decompose a board into per-task files plus a layout-only `board.json` manifest.
 * Ranks are reconciled against the existing files so only moved/new tasks are
 * rewritten; files for removed tasks are deleted. Assumes the caller already holds
 * the workspace-directory lock (writes pass `lock: null`, matching the sibling
 * sessions/requirements writes in workspace-state).
 */
export async function saveShardedBoard(boardDir: string, board: RuntimeBoardData): Promise<void> {
	const existingRanks = new Map<string, string>();
	for (const task of await readStoredTasks(boardDir)) {
		existingRanks.set(task.id, task.rank);
	}

	const liveTaskIds = new Set<string>();
	const dependsOnByTask = new Map<string, Array<{ id: string; toTaskId: string; createdAt: number }>>();
	for (const column of board.columns) {
		for (const cardEntry of column.cards) {
			liveTaskIds.add(cardEntry.id);
		}
	}
	// Edges are stored on their from-task file; drop any whose owner is gone (the
	// same cleanup the read path's updateTaskDependencies performs).
	for (const dependency of board.dependencies) {
		if (!liveTaskIds.has(dependency.fromTaskId)) {
			continue;
		}
		const edges = dependsOnByTask.get(dependency.fromTaskId);
		const edge = { id: dependency.id, toTaskId: dependency.toTaskId, createdAt: dependency.createdAt };
		if (edges) {
			edges.push(edge);
		} else {
			dependsOnByTask.set(dependency.fromTaskId, [edge]);
		}
	}

	// Flatten the board into the per-task shards to write, reconciling ranks per
	// column. Writing concurrently (bounded by the shared file budget) instead of
	// one serial `await` per card keeps a thousand-task save off the critical path
	// without risking an EMFILE burst.
	const storedTasks: StoredTask[] = [];
	for (const column of board.columns) {
		const ranks = reconcileColumnRanks(
			column.cards.map((cardEntry) => cardEntry.id),
			existingRanks,
		);
		for (const cardEntry of column.cards) {
			storedTasks.push({
				...cardEntry,
				column: column.id,
				rank: ranks.get(cardEntry.id) as string,
				dependsOn: dependsOnByTask.get(cardEntry.id) ?? [],
			});
		}
	}
	// writeJsonFileAtomic skips the write when the serialized content is unchanged,
	// so unmoved tasks leave no diff.
	await mapFilesConcurrent(storedTasks, (stored) =>
		lockedFileSystem.writeJsonFileAtomic(taskFilePath(boardDir, stored.id), stored, { lock: null }),
	);

	const removedIds = (await listTaskFileIds(tasksDirPath(boardDir))).filter(
		(existingId) => !liveTaskIds.has(existingId),
	);
	await mapFilesConcurrent(removedIds, (existingId) => rm(taskFilePath(boardDir, existingId), { force: true }));

	const manifest = {
		version: BOARD_MANIFEST_VERSION,
		columns: board.columns.map((column) => ({ id: column.id, title: column.title })),
	};
	await lockedFileSystem.writeJsonFileAtomic(boardManifestPath(boardDir), manifest, { lock: null });
}

/**
 * True when the board on disk is still the legacy single-file form and should be
 * migrated to shards. Cheap (no lock); callers gate {@link convertBoardToShards}
 * on this to acquire the workspace lock only when a conversion is actually due.
 */
export async function boardNeedsSharding(boardDir: string, legacyBoardDir?: string): Promise<boolean> {
	const source = await resolveSourceDir(boardDir, legacyBoardDir);
	return isOldShapeBoard(await readJson(boardManifestPath(source)));
}

/**
 * Convert a legacy single-file board into shards inside `boardDir`. Idempotent:
 * a no-op once the board is already sharded. The legacy source (which may be the
 * machine-rooted fallback) is read but never mutated. Caller must hold the
 * workspace-directory lock.
 */
export async function convertBoardToShards(boardDir: string, legacyBoardDir?: string): Promise<void> {
	const source = await resolveSourceDir(boardDir, legacyBoardDir);
	const rawManifest = await readJson(boardManifestPath(source));
	if (!isOldShapeBoard(rawManifest)) {
		return;
	}
	await saveShardedBoard(boardDir, parseBoardDataOrThrow(rawManifest, boardManifestPath(source)));
}
