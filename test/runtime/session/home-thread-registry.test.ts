import { describe, expect, it } from "vitest";

import type { RuntimeHomeChatThreadsData } from "../../../src/core/api-contract";
import { DEFAULT_HOME_THREAD_ID } from "../../../src/core/home-agent-session";
import {
	closeHomeThread,
	createHomeThread,
	deriveProvisionalThreadTitle,
	getHomeFullscreenTabs,
	listHomeThreads,
	renameHomeThread,
	sanitizeFullscreenTabs,
	setHomeFullscreenTabs,
	setHomeThreadAutoTitle,
	setHomeThreadNextStep,
} from "../../../src/session/home-thread-registry";

function seed(): RuntimeHomeChatThreadsData {
	return {
		threads: [
			{ id: "t1", agentId: "pi", name: "First", titleSource: "manual", createdAt: 100, updatedAt: 100 },
			{ id: "t2", agentId: "claude", name: "Second", titleSource: "auto", createdAt: 50, updatedAt: 50 },
		],
	};
}

/** A registry that also has open fullscreen session tabs persisted. */
function seedWithTabs(): RuntimeHomeChatThreadsData {
	return {
		...seed(),
		fullscreenTabs: { openThreadIds: ["t1", "t2"], activeThreadId: "t2" },
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

		it("preserves the persisted fullscreen tab set (regression: creating a thread closed all open tabs)", () => {
			const next = createHomeThread(seedWithTabs(), { id: "t3", agentId: "codex", name: "Third", now: 200 });
			expect(next.fullscreenTabs).toEqual({ openThreadIds: ["t1", "t2"], activeThreadId: "t2" });
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

		it("preserves the persisted fullscreen tab set", () => {
			const next = renameHomeThread(seedWithTabs(), "t2", "Renamed", 300);
			expect(next.fullscreenTabs).toEqual({ openThreadIds: ["t1", "t2"], activeThreadId: "t2" });
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

		it("preserves the persisted fullscreen tab set when a title is applied", () => {
			const { next } = setHomeThreadAutoTitle(seedWithTabs(), "t2", "Summarized", 400);
			expect(next.fullscreenTabs).toEqual({ openThreadIds: ["t1", "t2"], activeThreadId: "t2" });
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

	describe("setHomeThreadNextStep", () => {
		it("sets the pending next-step suggestion without bumping updatedAt", () => {
			const next = setHomeThreadNextStep(seed(), "t2", "Start the top backlog task");
			const thread = next.threads.find((t) => t.id === "t2");
			expect(thread?.pendingNextStep).toBe("Start the top backlog task");
			// Transient state: updatedAt (title/identity) is untouched.
			expect(thread?.updatedAt).toBe(50);
		});

		it("clears the suggestion when passed null", () => {
			const withSuggestion = setHomeThreadNextStep(seed(), "t1", "Do the thing");
			const cleared = setHomeThreadNextStep(withSuggestion, "t1", null);
			expect(cleared.threads.find((t) => t.id === "t1")?.pendingNextStep).toBeNull();
		});

		it("does not mutate the source data", () => {
			const data = seed();
			setHomeThreadNextStep(data, "t1", "Do the thing");
			expect(data.threads.find((t) => t.id === "t1")?.pendingNextStep).toBeUndefined();
		});

		it("throws when the thread does not exist", () => {
			expect(() => setHomeThreadNextStep(seed(), "missing", "x")).toThrow();
		});

		it("preserves the persisted fullscreen tab set", () => {
			const next = setHomeThreadNextStep(seedWithTabs(), "t2", "Start the top backlog task");
			expect(next.fullscreenTabs).toEqual({ openThreadIds: ["t1", "t2"], activeThreadId: "t2" });
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

		it("prunes the closed thread from the persisted fullscreen tab set", () => {
			const data: RuntimeHomeChatThreadsData = {
				...seed(),
				fullscreenTabs: { openThreadIds: ["t1", "t2"], activeThreadId: "t1" },
			};
			const { next } = closeHomeThread(data, "t1");
			expect(next.fullscreenTabs).toEqual({ openThreadIds: ["t2"], activeThreadId: null });
		});
	});

	describe("fullscreen tabs", () => {
		describe("getHomeFullscreenTabs", () => {
			it("returns an empty Home-active tab set when none is persisted", () => {
				expect(getHomeFullscreenTabs(seed())).toEqual({ openThreadIds: [], activeThreadId: null });
			});

			it("returns the persisted tab set", () => {
				const data: RuntimeHomeChatThreadsData = {
					...seed(),
					fullscreenTabs: { openThreadIds: ["t1"], activeThreadId: "t1" },
				};
				expect(getHomeFullscreenTabs(data)).toEqual({ openThreadIds: ["t1"], activeThreadId: "t1" });
			});
		});

		describe("sanitizeFullscreenTabs", () => {
			it("drops open ids that are not real threads, dedupes, and preserves order", () => {
				const result = sanitizeFullscreenTabs(
					{ openThreadIds: ["t2", "ghost", "t1", "t1"], activeThreadId: "t2" },
					["t1", "t2"],
				);
				expect(result).toEqual({ openThreadIds: ["t2", "t1"], activeThreadId: "t2" });
			});

			it("keeps the synthetic default thread as a valid open tab", () => {
				const result = sanitizeFullscreenTabs(
					{ openThreadIds: [DEFAULT_HOME_THREAD_ID, "t1"], activeThreadId: DEFAULT_HOME_THREAD_ID },
					["t1", "t2"],
				);
				expect(result.openThreadIds).toEqual([DEFAULT_HOME_THREAD_ID, "t1"]);
				expect(result.activeThreadId).toBe(DEFAULT_HOME_THREAD_ID);
			});

			it("falls back to the Home tab when the active id is not open", () => {
				const result = sanitizeFullscreenTabs({ openThreadIds: ["t1"], activeThreadId: "ghost" }, ["t1", "t2"]);
				expect(result.activeThreadId).toBeNull();
			});
		});

		describe("setHomeFullscreenTabs", () => {
			it("persists a sanitized tab set without touching the threads", () => {
				const data = seed();
				const next = setHomeFullscreenTabs(data, { openThreadIds: ["t1", "ghost"], activeThreadId: "t1" });
				expect(next.fullscreenTabs).toEqual({ openThreadIds: ["t1"], activeThreadId: "t1" });
				expect(next.threads).toBe(data.threads);
			});

			it("returns the same data reference when the sanitized tab set is unchanged", () => {
				const data: RuntimeHomeChatThreadsData = {
					...seed(),
					fullscreenTabs: { openThreadIds: ["t1"], activeThreadId: "t1" },
				};
				const next = setHomeFullscreenTabs(data, { openThreadIds: ["t1", "ghost"], activeThreadId: "t1" });
				expect(next).toBe(data);
			});

			it("does not mutate the source data", () => {
				const data = seed();
				setHomeFullscreenTabs(data, { openThreadIds: ["t1"], activeThreadId: "t1" });
				expect(data.fullscreenTabs).toBeUndefined();
			});
		});
	});
});
