import { describe, expect, it } from "vitest";

import type { RuntimeHomeChatThreadsData } from "../../../src/core/api-contract";
import {
	closeHomeThread,
	createHomeThread,
	listHomeThreads,
	renameHomeThread,
	setHomeThreadTakeover,
} from "../../../src/session/home-thread-registry";

function seed(): RuntimeHomeChatThreadsData {
	return {
		threads: [
			{ id: "t1", agentId: "pi", name: "First", takeoverEnabled: false, createdAt: 100, updatedAt: 100 },
			{ id: "t2", agentId: "claude", name: "Second", takeoverEnabled: false, createdAt: 50, updatedAt: 50 },
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
				takeoverEnabled: false,
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

	describe("setHomeThreadTakeover", () => {
		it("toggles takeoverEnabled and bumps updatedAt", () => {
			const next = setHomeThreadTakeover(seed(), "t1", { enabled: true }, 300);
			const thread = next.threads.find((t) => t.id === "t1");
			expect(thread?.takeoverEnabled).toBe(true);
			expect(thread?.updatedAt).toBe(300);
			expect(thread?.createdAt).toBe(100);
		});

		it("sets and clears the extension reference", () => {
			const withExt = setHomeThreadTakeover(seed(), "t1", { enabled: true, extension: "playbook" }, 300);
			expect(withExt.threads.find((t) => t.id === "t1")?.takeoverExtension).toBe("playbook");
			const cleared = setHomeThreadTakeover(withExt, "t1", { enabled: true, extension: null }, 400);
			expect(cleared.threads.find((t) => t.id === "t1")?.takeoverExtension).toBeUndefined();
		});

		it("keeps the existing extension when extension is omitted", () => {
			const withExt = setHomeThreadTakeover(seed(), "t1", { enabled: true, extension: "playbook" }, 300);
			const toggledOff = setHomeThreadTakeover(withExt, "t1", { enabled: false }, 400);
			expect(toggledOff.threads.find((t) => t.id === "t1")?.takeoverExtension).toBe("playbook");
			expect(toggledOff.threads.find((t) => t.id === "t1")?.takeoverEnabled).toBe(false);
		});

		it("throws when the thread does not exist", () => {
			expect(() => setHomeThreadTakeover(seed(), "missing", { enabled: true }, 300)).toThrow();
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
});
