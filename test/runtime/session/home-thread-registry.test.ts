import { describe, expect, it } from "vitest";

import type { RuntimeHomeChatThreadsData } from "../../../src/core/api-contract";
import {
	closeHomeThread,
	createHomeThread,
	decideAskThread,
	listHomeThreads,
	renameHomeThread,
} from "../../../src/session/home-thread-registry";

function seed(): RuntimeHomeChatThreadsData {
	return {
		threads: [
			{ id: "t1", agentId: "pi", name: "First", createdAt: 100, updatedAt: 100 },
			{ id: "t2", agentId: "claude", name: "Second", createdAt: 50, updatedAt: 50 },
		],
	};
}

describe("home thread registry", () => {
	describe("listHomeThreads", () => {
		it("returns threads sorted by createdAt ascending", () => {
			const threads = listHomeThreads(seed());
			expect(threads.map((t) => t.id)).toEqual(["t2", "t1"]);
		});

		it("does not mutate the source data", () => {
			const data = seed();
			listHomeThreads(data);
			expect(data.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
		});
	});

	describe("createHomeThread", () => {
		it("appends a new thread with createdAt/updatedAt set to now", () => {
			const next = createHomeThread(seed(), { id: "t3", agentId: "codex", name: "Third", now: 200 });
			const created = next.threads.find((t) => t.id === "t3");
			expect(created).toEqual({
				id: "t3",
				agentId: "codex",
				name: "Third",
				createdAt: 200,
				updatedAt: 200,
			});
			expect(next.threads).toHaveLength(3);
		});

		it("does not mutate the source data", () => {
			const data = seed();
			createHomeThread(data, { id: "t3", agentId: "codex", name: "Third", now: 200 });
			expect(data.threads).toHaveLength(2);
		});

		it("throws when the thread id already exists", () => {
			expect(() => createHomeThread(seed(), { id: "t1", agentId: "pi", name: "Dup", now: 200 })).toThrow();
		});
	});

	describe("renameHomeThread", () => {
		it("updates the name and updatedAt", () => {
			const next = renameHomeThread(seed(), "t1", "Renamed", 300);
			const renamed = next.threads.find((t) => t.id === "t1");
			expect(renamed?.name).toBe("Renamed");
			expect(renamed?.updatedAt).toBe(300);
			expect(renamed?.createdAt).toBe(100);
		});

		it("throws when the thread does not exist", () => {
			expect(() => renameHomeThread(seed(), "missing", "x", 300)).toThrow();
		});
	});

	describe("closeHomeThread", () => {
		it("removes the thread and returns the removed entry", () => {
			const { next, removed } = closeHomeThread(seed(), "t1");
			expect(next.threads.map((t) => t.id)).toEqual(["t2"]);
			expect(removed.id).toBe("t1");
		});

		it("throws when the thread does not exist", () => {
			expect(() => closeHomeThread(seed(), "missing")).toThrow();
		});
	});

	describe("decideAskThread", () => {
		it("targets an existing registered thread, using its registered agent", () => {
			// The registry agent is authoritative even if the stale origin disagrees.
			const decision = decideAskThread({ origin: { agentId: "pi", threadId: "t2" }, threads: seed().threads });
			expect(decision).toEqual({ kind: "existing", agentId: "claude", threadId: "t2" });
		});

		it("targets the implicit default thread without requiring a registry entry", () => {
			// The default thread keeps the legacy three-segment session id and is never
			// listed in threads.json, so it resolves directly from the origin's agent.
			const decision = decideAskThread({ origin: { agentId: "pi", threadId: "default" }, threads: [] });
			expect(decision).toEqual({ kind: "existing", agentId: "pi", threadId: "default" });
		});

		it("falls back to create when the origin thread was closed (missing from the registry)", () => {
			const decision = decideAskThread({ origin: { agentId: "pi", threadId: "gone" }, threads: seed().threads });
			expect(decision).toEqual({ kind: "create" });
		});

		it("falls back to create when there is no origin at all", () => {
			expect(decideAskThread({ origin: null, threads: seed().threads })).toEqual({ kind: "create" });
			expect(decideAskThread({ origin: undefined, threads: seed().threads })).toEqual({ kind: "create" });
		});
	});
});
