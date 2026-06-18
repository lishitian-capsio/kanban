import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	DEFAULT_BOARD_BRANCH,
	getBoardRefPath,
	isBoardDecouplingActive,
	readBoardRef,
	writeBoardRef,
} from "../../../src/state/board-ref";
import { createTempDir } from "../../utilities/temp-dir";

describe("board-ref", () => {
	it("resolves the pointer path to <repo>/.kanban/board-ref", () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-board-ref-");
		try {
			expect(getBoardRefPath(repoPath)).toBe(join(repoPath, ".kanban", "board-ref"));
		} finally {
			cleanup();
		}
	});

	it("reports decoupling inactive and reads null when the pointer is absent", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-board-ref-");
		try {
			expect(isBoardDecouplingActive(repoPath)).toBe(false);
			expect(await readBoardRef(repoPath)).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("round-trips a written pointer and then reports decoupling active", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-board-ref-");
		try {
			await writeBoardRef(repoPath, { version: 1, branch: DEFAULT_BOARD_BRANCH });
			expect(isBoardDecouplingActive(repoPath)).toBe(true);
			expect(await readBoardRef(repoPath)).toEqual({ version: 1, branch: DEFAULT_BOARD_BRANCH });
		} finally {
			cleanup();
		}
	});

	it("throws on a malformed pointer rather than silently ignoring it", async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-board-ref-");
		try {
			mkdirSync(join(repoPath, ".kanban"), { recursive: true });
			writeFileSync(getBoardRefPath(repoPath), "{ not json", "utf8");
			await expect(readBoardRef(repoPath)).rejects.toThrow();
		} finally {
			cleanup();
		}
	});
});
