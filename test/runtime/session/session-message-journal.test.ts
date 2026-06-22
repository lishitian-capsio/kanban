import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SessionMessage } from "../../../src/session/session-message";
import {
	FileSessionMessageJournal,
	mergeSessionMessages,
	NoopSessionMessageJournal,
} from "../../../src/session/session-message-journal";
import { createTempDir } from "../../utilities/temp-dir";

function message(overrides: Partial<SessionMessage> & Pick<SessionMessage, "id">): SessionMessage {
	return {
		role: "assistant",
		content: "",
		createdAt: 1,
		...overrides,
	};
}

function messageFilePath(sessionsDir: string, taskId: string): string {
	return join(sessionsDir, taskId, "messages.jsonl");
}

function rawLines(sessionsDir: string, taskId: string): string[] {
	const raw = readFileSync(messageFilePath(sessionsDir, taskId), "utf8");
	return raw.split("\n").filter((line) => line.length > 0);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FileSessionMessageJournal", () => {
	it("persists a recorded message and loads it back after flush", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			journal.recordMessage("t1", message({ id: "m1", role: "user", content: "hello", createdAt: 10 }));
			await journal.flush();

			const loaded = await journal.loadMessages("t1");
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.id).toBe("m1");
			expect(loaded[0]?.content).toBe("hello");
		} finally {
			dir.cleanup();
		}
	});

	it("coalesces same-id streaming updates into a single line", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			for (let index = 1; index <= 500; index += 1) {
				journal.recordMessage("t1", message({ id: "stream", content: "x".repeat(index), createdAt: 5 }));
			}
			await journal.flush();

			expect(rawLines(dir.path, "t1")).toHaveLength(1);
			const loaded = await journal.loadMessages("t1");
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.content).toBe("x".repeat(500));
		} finally {
			dir.cleanup();
		}
	});

	it("persists distinct messages in record order", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			journal.recordMessage("t1", message({ id: "u", role: "user", content: "do it", createdAt: 1 }));
			journal.recordMessage("t1", message({ id: "a", role: "assistant", content: "working", createdAt: 2 }));
			journal.recordMessage("t1", message({ id: "tool", role: "tool", content: "ran", createdAt: 3 }));
			await journal.flush();

			const loaded = await journal.loadMessages("t1");
			expect(loaded.map((entry) => entry.id)).toEqual(["u", "a", "tool"]);
		} finally {
			dir.cleanup();
		}
	});

	it("dedupes by id keeping the latest content across flushes", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			journal.recordMessage("t1", message({ id: "a", content: "first", createdAt: 1 }));
			await journal.flush();
			journal.recordMessage("t1", message({ id: "a", content: "second", createdAt: 1 }));
			await journal.flush();

			const loaded = await journal.loadMessages("t1");
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.content).toBe("second");
		} finally {
			dir.cleanup();
		}
	});

	it("does not re-append identical content", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			journal.recordMessage("t1", message({ id: "a", content: "same", createdAt: 1 }));
			await journal.flush();
			journal.recordMessage("t1", message({ id: "a", content: "same", createdAt: 1 }));
			await journal.flush();

			expect(rawLines(dir.path, "t1")).toHaveLength(1);
		} finally {
			dir.cleanup();
		}
	});

	it("clears persisted messages for a task", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			journal.recordMessage("t1", message({ id: "a", content: "gone", createdAt: 1 }));
			await journal.flush();
			await journal.clear("t1");

			expect(await journal.loadMessages("t1")).toEqual([]);
		} finally {
			dir.cleanup();
		}
	});

	it("tolerates a torn trailing line from a crash", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const taskDir = join(dir.path, "t1");
			mkdirSync(taskDir, { recursive: true });
			const good = JSON.stringify(message({ id: "a", content: "intact", createdAt: 1 }));
			writeFileSync(messageFilePath(dir.path, "t1"), `${good}\n{"id":"b","content":"trunc`);

			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			const loaded = await journal.loadMessages("t1");
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.id).toBe("a");
		} finally {
			dir.cleanup();
		}
	});

	it("caps the transcript and records a truncation marker", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const infos: string[] = [];
			const journal = new FileSessionMessageJournal({
				sessionsDir: dir.path,
				maxMessages: 2,
				onInfo: (text) => infos.push(text),
			});
			for (let index = 1; index <= 4; index += 1) {
				journal.recordMessage("t1", message({ id: `m${index}`, content: `c${index}`, createdAt: index }));
			}
			await journal.flush();

			const loaded = await journal.loadMessages("t1");
			const contents = loaded.map((entry) => entry.content);
			expect(contents).toContain("c3");
			expect(contents).toContain("c4");
			expect(contents).not.toContain("c1");
			expect(loaded.some((entry) => entry.role === "status")).toBe(true);
			expect(infos.length).toBeGreaterThan(0);
		} finally {
			dir.cleanup();
		}
	});

	it("bounds the raw line count while streaming a never-read message", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({
				sessionsDir: dir.path,
				flushDelayMs: 5,
				compactionStaleThreshold: 4,
			});
			// Drive 20 debounced appends of the same growing message without ever
			// reading it back. Without mid-stream compaction this would leave ~20
			// redundant lines; the stale-line threshold must keep it bounded.
			for (let index = 1; index <= 20; index += 1) {
				journal.recordMessage("t1", message({ id: "stream", content: "x".repeat(index), createdAt: 5 }));
				await delay(12);
			}

			expect(rawLines(dir.path, "t1").length).toBeLessThanOrEqual(6);

			const loaded = await journal.loadMessages("t1");
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.content).toBe("x".repeat(20));
		} finally {
			dir.cleanup();
		}
	});

	it("preserves distinct messages across a mid-stream compaction", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({
				sessionsDir: dir.path,
				flushDelayMs: 5,
				compactionStaleThreshold: 3,
			});
			journal.recordMessage("t1", message({ id: "u", role: "user", content: "do it", createdAt: 1 }));
			await delay(12);
			for (let index = 1; index <= 12; index += 1) {
				journal.recordMessage(
					"t1",
					message({ id: "a", role: "assistant", content: "x".repeat(index), createdAt: 2 }),
				);
				await delay(12);
			}
			await journal.flush();

			const loaded = await journal.loadMessages("t1");
			expect(loaded.map((entry) => entry.id)).toEqual(["u", "a"]);
			expect(loaded.find((entry) => entry.id === "a")?.content).toBe("x".repeat(12));
		} finally {
			dir.cleanup();
		}
	});

	it("compacts superseded lines on flush without needing a read", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			// A high threshold means mid-stream compaction never fires; flush must
			// still collapse the accumulated same-id snapshots on its own.
			const journal = new FileSessionMessageJournal({
				sessionsDir: dir.path,
				compactionStaleThreshold: 10_000,
			});
			for (let index = 1; index <= 8; index += 1) {
				journal.recordMessage("t1", message({ id: "s", content: "x".repeat(index), createdAt: 1 }));
				await journal.flush();
			}

			expect(rawLines(dir.path, "t1")).toHaveLength(1);
			const loaded = await journal.loadMessages("t1");
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.content).toBe("x".repeat(8));
		} finally {
			dir.cleanup();
		}
	});

	it("returns an empty transcript when nothing was recorded", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			expect(await journal.loadMessages("missing")).toEqual([]);
		} finally {
			dir.cleanup();
		}
	});

	it("advances the per-task generation on record but not on read/compaction", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			expect(journal.getGeneration("t1")).toBe(0);

			journal.recordMessage("t1", message({ id: "m1", content: "a", createdAt: 1 }));
			const afterFirst = journal.getGeneration("t1");
			expect(afterFirst).toBeGreaterThan(0);

			await journal.flush();
			await journal.loadMessages("t1");
			// A read (and its opportunistic compaction) preserves logical content, so
			// the generation must not move — that is what keeps the merge cache warm.
			expect(journal.getGeneration("t1")).toBe(afterFirst);

			journal.recordMessage("t1", message({ id: "m2", content: "b", createdAt: 2 }));
			expect(journal.getGeneration("t1")).toBeGreaterThan(afterFirst);
		} finally {
			dir.cleanup();
		}
	});

	it("advances the generation when a transcript is cleared", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			journal.recordMessage("t1", message({ id: "m1", content: "a", createdAt: 1 }));
			const before = journal.getGeneration("t1");
			await journal.clear("t1");
			expect(journal.getGeneration("t1")).toBeGreaterThan(before);
		} finally {
			dir.cleanup();
		}
	});

	it("tracks generations independently per task", async () => {
		const dir = createTempDir("kanban-journal-");
		try {
			const journal = new FileSessionMessageJournal({ sessionsDir: dir.path });
			journal.recordMessage("t1", message({ id: "m1", content: "a", createdAt: 1 }));
			expect(journal.getGeneration("t1")).toBeGreaterThan(0);
			expect(journal.getGeneration("t2")).toBe(0);
		} finally {
			dir.cleanup();
		}
	});
});

describe("NoopSessionMessageJournal", () => {
	it("records nothing and always loads an empty transcript", async () => {
		const journal = new NoopSessionMessageJournal();
		journal.recordMessage("t1", message({ id: "a", content: "x", createdAt: 1 }));
		await journal.flush();
		expect(await journal.loadMessages("t1")).toEqual([]);
		await journal.clear("t1");
	});

	it("reports a constant generation since it never persists", () => {
		const journal = new NoopSessionMessageJournal();
		expect(journal.getGeneration("t1")).toBe(0);
		journal.recordMessage("t1", message({ id: "a", content: "x", createdAt: 1 }));
		expect(journal.getGeneration("t1")).toBe(0);
	});
});

describe("mergeSessionMessages", () => {
	it("keeps persisted order, overrides matching ids from live, and appends new live messages", () => {
		const persisted: SessionMessage[] = [
			message({ id: "a", content: "a-old", createdAt: 1 }),
			message({ id: "b", content: "b-old", createdAt: 2 }),
		];
		const live: SessionMessage[] = [
			message({ id: "b", content: "b-new", createdAt: 2 }),
			message({ id: "c", content: "c-new", createdAt: 3 }),
		];

		const merged = mergeSessionMessages(persisted, live);
		expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
		expect(merged.find((entry) => entry.id === "b")?.content).toBe("b-new");
	});

	it("returns persisted messages unchanged when live is empty", () => {
		const persisted: SessionMessage[] = [message({ id: "a", content: "a", createdAt: 1 })];
		expect(mergeSessionMessages(persisted, [])).toEqual(persisted);
	});
});
