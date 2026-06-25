import { describe, expect, it } from "vitest";

import type { RuntimeHomeChatThreadsData } from "../../../src/core/api-contract";
import {
	closeHomeThread,
	createHomeThread,
	deriveProvisionalThreadTitle,
	listHomeThreads,
	renameHomeThread,
	setHomeThreadAutoTitle,
} from "../../../src/session/home-thread-registry";

function seed(): RuntimeHomeChatThreadsData {
	return {
		threads: [
			{ id: "t1", agentId: "pi", name: "First", titleSource: "manual", createdAt: 100, updatedAt: 100 },
			{ id: "t2", agentId: "claude", name: "Second", titleSource: "auto", createdAt: 50, updatedAt: 50 },
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
		it("appends a new thread with createdAt/updatedAt set to now and the given titleSource", () => {
			const next = createHomeThread(seed(), {
				id: "t3",
				agentId: "codex",
				name: "Third",
				titleSource: "auto",
				now: 200,
			});
			const created = next.threads.find((t) => t.id === "t3");
			expect(created).toEqual({
				id: "t3",
				agentId: "codex",
				name: "Third",
				titleSource: "auto",
				createdAt: 200,
				updatedAt: 200,
			});
			expect(next.threads).toHaveLength(3);
		});

		it("defaults titleSource to manual when omitted", () => {
			const next = createHomeThread(seed(), { id: "t3", agentId: "codex", name: "Third", now: 200 });
			expect(next.threads.find((t) => t.id === "t3")?.titleSource).toBe("manual");
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
		it("updates the name and updatedAt and pins the title as manual", () => {
			// t2 starts as an auto title; a user rename pins it manual.
			const next = renameHomeThread(seed(), "t2", "Renamed", 300);
			const renamed = next.threads.find((t) => t.id === "t2");
			expect(renamed?.name).toBe("Renamed");
			expect(renamed?.titleSource).toBe("manual");
			expect(renamed?.updatedAt).toBe(300);
			expect(renamed?.createdAt).toBe(50);
		});

		it("throws when the thread does not exist", () => {
			expect(() => renameHomeThread(seed(), "missing", "x", 300)).toThrow();
		});
	});

	describe("setHomeThreadAutoTitle", () => {
		it("sets an auto title and bumps updatedAt when the title is not pinned", () => {
			const { next, applied, thread } = setHomeThreadAutoTitle(seed(), "t2", "Summarized", 400);
			expect(applied).toBe(true);
			expect(thread.name).toBe("Summarized");
			expect(thread.titleSource).toBe("auto");
			expect(thread.updatedAt).toBe(400);
			expect(next.threads.find((t) => t.id === "t2")?.name).toBe("Summarized");
		});

		it("leaves a manually-pinned title untouched", () => {
			// t1 is manual; an agent set-title must be a no-op.
			const data = seed();
			const { next, applied, thread } = setHomeThreadAutoTitle(data, "t1", "Agent title", 400);
			expect(applied).toBe(false);
			expect(thread.name).toBe("First");
			expect(thread.titleSource).toBe("manual");
			expect(next).toBe(data);
		});

		it("does not mutate the source data", () => {
			const data = seed();
			setHomeThreadAutoTitle(data, "t2", "Summarized", 400);
			expect(data.threads.find((t) => t.id === "t2")?.name).toBe("Second");
		});

		it("throws when the thread does not exist", () => {
			expect(() => setHomeThreadAutoTitle(seed(), "missing", "x", 400)).toThrow();
		});
	});

	describe("deriveProvisionalThreadTitle", () => {
		it("uses the first non-empty line and collapses whitespace", () => {
			expect(deriveProvisionalThreadTitle("\n  Fix   the   login   bug \nmore detail")).toBe("Fix the login bug");
		});

		it("truncates long descriptions with an ellipsis", () => {
			const long = "a".repeat(80);
			const title = deriveProvisionalThreadTitle(long);
			expect(title.length).toBe(60);
			expect(title.endsWith("…")).toBe(true);
		});

		it("returns an empty string for blank input", () => {
			expect(deriveProvisionalThreadTitle("   \n  ")).toBe("");
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
