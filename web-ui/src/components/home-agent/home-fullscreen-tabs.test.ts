import { describe, expect, it } from "vitest";

import {
	activateHomeTab,
	closeSessionTab,
	deriveCompactActiveOnExit,
	MAX_OPEN_SESSION_TABS,
	openSessionTab,
	reconcileOnEnterFullscreen,
	setActiveSessionTab,
} from "./home-fullscreen-tabs";

describe("home fullscreen tabs", () => {
	describe("openSessionTab", () => {
		it("opens a new tab to the right and makes it active", () => {
			const next = openSessionTab({ openThreadIds: ["a"], activeThreadId: null }, "b");
			expect(next).toEqual({ openThreadIds: ["a", "b"], activeThreadId: "b" });
		});

		it("activates an already-open tab without reordering or duplicating it", () => {
			const next = openSessionTab({ openThreadIds: ["a", "b"], activeThreadId: "b" }, "a");
			expect(next).toEqual({ openThreadIds: ["a", "b"], activeThreadId: "a" });
		});

		it("evicts the oldest tab when exceeding the cap", () => {
			const open = Array.from({ length: MAX_OPEN_SESSION_TABS }, (_, i) => `t${i}`);
			const next = openSessionTab({ openThreadIds: open, activeThreadId: "t0" }, "new");
			expect(next.openThreadIds).toHaveLength(MAX_OPEN_SESSION_TABS);
			expect(next.openThreadIds[0]).toBe("t1");
			expect(next.openThreadIds.at(-1)).toBe("new");
			expect(next.activeThreadId).toBe("new");
		});
	});

	describe("closeSessionTab", () => {
		it("removes the tab and falls back to the Home tab when it was the only one", () => {
			const next = closeSessionTab({ openThreadIds: ["a"], activeThreadId: "a" }, "a");
			expect(next).toEqual({ openThreadIds: [], activeThreadId: null });
		});

		it("activates the tab that shifts into the closed slot", () => {
			const next = closeSessionTab({ openThreadIds: ["a", "b", "c"], activeThreadId: "b" }, "b");
			expect(next).toEqual({ openThreadIds: ["a", "c"], activeThreadId: "c" });
		});

		it("activates the last tab when closing the active last tab", () => {
			const next = closeSessionTab({ openThreadIds: ["a", "b", "c"], activeThreadId: "c" }, "c");
			expect(next).toEqual({ openThreadIds: ["a", "b"], activeThreadId: "b" });
		});

		it("keeps the active tab when closing a different tab", () => {
			const next = closeSessionTab({ openThreadIds: ["a", "b", "c"], activeThreadId: "a" }, "c");
			expect(next).toEqual({ openThreadIds: ["a", "b"], activeThreadId: "a" });
		});

		it("returns the same state when the tab is not open", () => {
			const state = { openThreadIds: ["a"], activeThreadId: "a" };
			expect(closeSessionTab(state, "ghost")).toBe(state);
		});
	});

	describe("setActiveSessionTab", () => {
		it("activates an open tab", () => {
			expect(setActiveSessionTab({ openThreadIds: ["a", "b"], activeThreadId: "a" }, "b")).toEqual({
				openThreadIds: ["a", "b"],
				activeThreadId: "b",
			});
		});

		it("returns the same state for a tab that is not open", () => {
			const state = { openThreadIds: ["a"], activeThreadId: "a" };
			expect(setActiveSessionTab(state, "ghost")).toBe(state);
		});
	});

	describe("activateHomeTab", () => {
		it("clears the active tab so the Home launcher shows", () => {
			expect(activateHomeTab({ openThreadIds: ["a"], activeThreadId: "a" })).toEqual({
				openThreadIds: ["a"],
				activeThreadId: null,
			});
		});
	});

	describe("reconcileOnEnterFullscreen", () => {
		it("restores the persisted open tab set + active tab unchanged when non-empty", () => {
			const persisted = { openThreadIds: ["a", "b"], activeThreadId: "b" };
			expect(reconcileOnEnterFullscreen(persisted, "c")).toBe(persisted);
		});

		it("seeds the current conversation as the first tab when no tabs are persisted", () => {
			expect(reconcileOnEnterFullscreen({ openThreadIds: [], activeThreadId: null }, "c")).toEqual({
				openThreadIds: ["c"],
				activeThreadId: "c",
			});
		});

		it("stays on the Home tab when nothing is persisted and there is no current conversation", () => {
			expect(reconcileOnEnterFullscreen({ openThreadIds: [], activeThreadId: null }, null)).toEqual({
				openThreadIds: [],
				activeThreadId: null,
			});
		});
	});

	describe("deriveCompactActiveOnExit", () => {
		it("carries the active session tab back to the compact conversation", () => {
			expect(deriveCompactActiveOnExit("b", "a")).toBe("b");
		});

		it("keeps the current compact conversation when the Home tab was active", () => {
			expect(deriveCompactActiveOnExit(null, "a")).toBe("a");
		});
	});
});
