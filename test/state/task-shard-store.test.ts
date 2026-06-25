import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import {
	boardNeedsSharding,
	convertBoardToShards,
	loadShardedBoard,
	saveShardedBoard,
} from "../../src/state/task-shard-store";
import { createTempDir } from "../utilities/temp-dir";

function card(id: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: `Task ${id}`,
		prompt: `Prompt for ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function board(overrides: Partial<RuntimeBoardData> = {}): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
		...overrides,
	};
}

/** Compare dependencies independent of array order. */
function sortDeps(data: RuntimeBoardData): RuntimeBoardData {
	return {
		...data,
		dependencies: [...data.dependencies].sort((a, b) => a.id.localeCompare(b.id)),
	};
}

describe("task shard store", () => {
	it("round-trips a board through per-task files and a layout manifest", async () => {
		const { path: dir, cleanup } = createTempDir("kanban-shard-");
		try {
			const input = board({
				columns: [
					{ id: "backlog", title: "Backlog", cards: [card("aaa"), card("bbb")] },
					{ id: "in_progress", title: "In Progress", cards: [card("ccc")] },
					{ id: "review", title: "Review", cards: [card("ddd")] },
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [{ id: "dep1", fromTaskId: "aaa", toTaskId: "ddd", createdAt: 5 }],
			});

			await saveShardedBoard(dir, input);
			const loaded = await loadShardedBoard(dir);

			expect(sortDeps(loaded)).toEqual(sortDeps(input));
		} finally {
			cleanup();
		}
	});

	it("writes one file per task plus a cards-free board.json manifest", async () => {
		const { path: dir, cleanup } = createTempDir("kanban-shard-");
		try {
			await saveShardedBoard(
				dir,
				board({
					columns: [
						{ id: "backlog", title: "Backlog", cards: [card("aaa")] },
						{ id: "in_progress", title: "In Progress", cards: [card("bbb")] },
						{ id: "review", title: "Review", cards: [] },
						{ id: "trash", title: "Done", cards: [] },
					],
				}),
			);

			expect(existsSync(join(dir, "tasks", "aaa.json"))).toBe(true);
			expect(existsSync(join(dir, "tasks", "bbb.json"))).toBe(true);

			const manifest = JSON.parse(readFileSync(join(dir, "board.json"), "utf8"));
			expect(manifest.columns.map((c: { id: string }) => c.id)).toEqual([
				"backlog",
				"in_progress",
				"review",
				"trash",
			]);
			// The manifest is layout-only: it never carries cards.
			expect(manifest.columns.every((c: Record<string, unknown>) => !("cards" in c))).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("stores a dependency on its from-task file and reconstructs the flat list", async () => {
		const { path: dir, cleanup } = createTempDir("kanban-shard-");
		try {
			await saveShardedBoard(
				dir,
				board({
					columns: [
						{ id: "backlog", title: "Backlog", cards: [card("from")] },
						{ id: "in_progress", title: "In Progress", cards: [] },
						{ id: "review", title: "Review", cards: [card("to")] },
						{ id: "trash", title: "Done", cards: [] },
					],
					dependencies: [{ id: "dep1", fromTaskId: "from", toTaskId: "to", createdAt: 7 }],
				}),
			);

			const fromFile = JSON.parse(readFileSync(join(dir, "tasks", "from.json"), "utf8"));
			expect(fromFile.dependsOn).toEqual([{ id: "dep1", toTaskId: "to", createdAt: 7 }]);
			// The blocker task file carries no outgoing edge.
			const toFile = JSON.parse(readFileSync(join(dir, "tasks", "to.json"), "utf8"));
			expect(toFile.dependsOn).toEqual([]);

			const loaded = await loadShardedBoard(dir);
			expect(loaded.dependencies).toEqual([{ id: "dep1", fromTaskId: "from", toTaskId: "to", createdAt: 7 }]);
		} finally {
			cleanup();
		}
	});

	it("re-ranks only the moved task, leaving sibling files byte-identical", async () => {
		const { path: dir, cleanup } = createTempDir("kanban-shard-");
		try {
			await saveShardedBoard(
				dir,
				board({
					columns: [
						{ id: "backlog", title: "Backlog", cards: [card("aaa"), card("bbb"), card("ccc")] },
						{ id: "in_progress", title: "In Progress", cards: [] },
						{ id: "review", title: "Review", cards: [] },
						{ id: "trash", title: "Done", cards: [] },
					],
				}),
			);

			const aBefore = readFileSync(join(dir, "tasks", "aaa.json"), "utf8");
			const cBefore = readFileSync(join(dir, "tasks", "ccc.json"), "utf8");
			const cMtimeBefore = statSync(join(dir, "tasks", "ccc.json")).mtimeMs;

			// Move "bbb" out of backlog into in_progress; aaa and ccc keep their positions.
			await saveShardedBoard(
				dir,
				board({
					columns: [
						{ id: "backlog", title: "Backlog", cards: [card("aaa"), card("ccc")] },
						{ id: "in_progress", title: "In Progress", cards: [card("bbb")] },
						{ id: "review", title: "Review", cards: [] },
						{ id: "trash", title: "Done", cards: [] },
					],
				}),
			);

			// Unmoved siblings keep their exact stored rank -> their files are not rewritten.
			expect(readFileSync(join(dir, "tasks", "aaa.json"), "utf8")).toBe(aBefore);
			expect(readFileSync(join(dir, "tasks", "ccc.json"), "utf8")).toBe(cBefore);
			expect(statSync(join(dir, "tasks", "ccc.json")).mtimeMs).toBe(cMtimeBefore);
			// The moved task now records its new column.
			const bFile = JSON.parse(readFileSync(join(dir, "tasks", "bbb.json"), "utf8"));
			expect(bFile.column).toBe("in_progress");
		} finally {
			cleanup();
		}
	});

	it("deletes the file for a task removed from the board", async () => {
		const { path: dir, cleanup } = createTempDir("kanban-shard-");
		try {
			await saveShardedBoard(
				dir,
				board({
					columns: [
						{ id: "backlog", title: "Backlog", cards: [card("keep"), card("drop")] },
						...board().columns.slice(1),
					],
				}),
			);
			expect(existsSync(join(dir, "tasks", "drop.json"))).toBe(true);

			await saveShardedBoard(
				dir,
				board({
					columns: [{ id: "backlog", title: "Backlog", cards: [card("keep")] }, ...board().columns.slice(1)],
				}),
			);

			expect(existsSync(join(dir, "tasks", "drop.json"))).toBe(false);
			expect(existsSync(join(dir, "tasks", "keep.json"))).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("migrates an old single-file board.json into shards (idempotently)", async () => {
		const { path: dir, cleanup } = createTempDir("kanban-shard-");
		try {
			const legacy = board({
				columns: [
					{ id: "backlog", title: "Backlog", cards: [card("aaa"), card("bbb")] },
					{ id: "in_progress", title: "In Progress", cards: [] },
					{ id: "review", title: "Review", cards: [card("ddd")] },
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [{ id: "dep1", fromTaskId: "aaa", toTaskId: "ddd", createdAt: 9 }],
			});
			writeFileSync(join(dir, "board.json"), JSON.stringify(legacy), "utf8");

			expect(await boardNeedsSharding(dir)).toBe(true);
			await convertBoardToShards(dir);

			// board.json is rewritten to a cards-free manifest, tasks are sharded.
			const manifest = JSON.parse(readFileSync(join(dir, "board.json"), "utf8"));
			expect(manifest.columns.every((c: Record<string, unknown>) => !("cards" in c))).toBe(true);
			expect(existsSync(join(dir, "tasks", "aaa.json"))).toBe(true);

			expect(sortDeps(await loadShardedBoard(dir))).toEqual(sortDeps(legacy));

			// Idempotent: a second pass is a no-op.
			expect(await boardNeedsSharding(dir)).toBe(false);
			const manifestBefore = readFileSync(join(dir, "board.json"), "utf8");
			await convertBoardToShards(dir);
			expect(readFileSync(join(dir, "board.json"), "utf8")).toBe(manifestBefore);
		} finally {
			cleanup();
		}
	});

	it("reads from a legacy board directory when the primary has no data yet", async () => {
		const { path: primary, cleanup: cleanupPrimary } = createTempDir("kanban-shard-primary-");
		const { path: legacyDir, cleanup: cleanupLegacy } = createTempDir("kanban-shard-legacy-");
		try {
			const legacy = board({
				columns: [{ id: "backlog", title: "Backlog", cards: [card("leg")] }, ...board().columns.slice(1)],
			});
			writeFileSync(join(legacyDir, "board.json"), JSON.stringify(legacy), "utf8");

			const loaded = await loadShardedBoard(primary, legacyDir);
			expect(loaded.columns[0]?.cards[0]?.id).toBe("leg");
			// Migration sources the legacy data but materializes shards in the primary dir.
			expect(await boardNeedsSharding(primary, legacyDir)).toBe(true);
		} finally {
			cleanupPrimary();
			cleanupLegacy();
		}
	});

	it("treats an absent or layout-only board as not needing sharding", async () => {
		const { path: dir, cleanup } = createTempDir("kanban-shard-");
		try {
			expect(await boardNeedsSharding(dir)).toBe(false);
			await saveShardedBoard(dir, board());
			expect(await boardNeedsSharding(dir)).toBe(false);
		} finally {
			cleanup();
		}
	});

	// Regression coverage for the P0 hard hang triggered by an inconsistent sharded
	// board (a hard kill landing mid board-sync/shard write). The read path must
	// degrade gracefully — never throw away the whole board, never emit a dangling
	// edge, and never spin — so the projects-payload broadcast fed by it can't wedge
	// the event loop. See the systematic-debugging investigation.
	describe("crash-torn / inconsistent shard tolerance", () => {
		/** Write a stored-task shard directly to mimic an on-disk shard set. */
		function writeShard(
			dir: string,
			id: string,
			column: string,
			rank: string,
			dependsOn: Array<{ id: string; toTaskId: string; createdAt: number }> = [],
		): void {
			mkdirSync(join(dir, "tasks"), { recursive: true });
			writeFileSync(
				join(dir, "tasks", `${id}.json`),
				JSON.stringify({ ...card(id), column, rank, dependsOn }),
				"utf8",
			);
		}

		it("skips a torn (unparseable) task shard instead of failing the whole board read", async () => {
			const { path: dir, cleanup } = createTempDir("kanban-shard-torn-");
			try {
				await saveShardedBoard(
					dir,
					board({
						columns: [{ id: "backlog", title: "Backlog", cards: [card("good")] }, ...board().columns.slice(1)],
					}),
				);
				// Simulate a shard truncated mid atomic write: valid filename, garbage bytes.
				writeFileSync(join(dir, "tasks", "torn.json"), '{ "id": "torn", "column": ', "utf8");

				const loaded = await loadShardedBoard(dir);
				const ids = loaded.columns.flatMap((column) => column.cards.map((c) => c.id));
				expect(ids).toContain("good");
				expect(ids).not.toContain("torn");
			} finally {
				cleanup();
			}
		});

		it("drops a dangling dependency edge whose target task is absent", async () => {
			const { path: dir, cleanup } = createTempDir("kanban-shard-dangling-");
			try {
				writeFileSync(
					join(dir, "board.json"),
					JSON.stringify({
						version: 1,
						columns: [
							{ id: "backlog", title: "Backlog" },
							{ id: "in_progress", title: "In Progress" },
							{ id: "review", title: "Review" },
							{ id: "trash", title: "Done" },
						],
					}),
					"utf8",
				);
				// A live backlog task carries an edge to a since-deleted task.
				writeShard(dir, "blocked", "backlog", "a0", [{ id: "edge", toTaskId: "gone", createdAt: 1 }]);

				const loaded = await loadShardedBoard(dir);
				expect(loaded.dependencies).toEqual([]);
			} finally {
				cleanup();
			}
		});

		it("loads quickly (no hang) for the linked + started + torn + dangling scenario", async () => {
			const { path: dir, cleanup } = createTempDir("kanban-shard-freeze-");
			try {
				writeFileSync(
					join(dir, "board.json"),
					JSON.stringify({
						version: 1,
						columns: [
							{ id: "backlog", title: "Backlog" },
							{ id: "in_progress", title: "In Progress" },
							{ id: "review", title: "Review" },
							{ id: "trash", title: "Done" },
						],
					}),
					"utf8",
				);
				// Prerequisite "prereq" was started (moved to in_progress); "blocked"
				// depends on it. A second torn shard and a dangling edge model the
				// inconsistency a mid-write kill leaves behind.
				writeShard(dir, "prereq", "in_progress", "a1");
				writeShard(dir, "blocked", "backlog", "a0", [
					{ id: "e1", toTaskId: "prereq", createdAt: 1 },
					{ id: "e2", toTaskId: "vanished", createdAt: 2 },
				]);
				writeFileSync(join(dir, "tasks", "torn.json"), "{ truncated", "utf8");

				const start = performance.now();
				const loaded = await loadShardedBoard(dir);
				const elapsedMs = performance.now() - start;

				expect(elapsedMs).toBeLessThan(2_000);
				const ids = loaded.columns.flatMap((column) => column.cards.map((c) => c.id));
				expect(ids).toEqual(expect.arrayContaining(["prereq", "blocked"]));
				// Only the real prereq edge survives; the dangling one is dropped.
				expect(loaded.dependencies).toEqual([
					{ id: "e1", fromTaskId: "blocked", toTaskId: "prereq", createdAt: 1 },
				]);
			} finally {
				cleanup();
			}
		});
	});
});
