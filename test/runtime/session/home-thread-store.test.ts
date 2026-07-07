import { describe, expect, it, vi } from "vitest";

import type { RuntimeHomeChatThreadsData } from "../../../src/core/api-contract";
import {
	HomeThreadCloseBlockedError,
	type HomeThreadPersistence,
	HomeThreadStore,
} from "../../../src/session/home-thread-store";

function inMemoryPersistence(initial: RuntimeHomeChatThreadsData = { threads: [] }): HomeThreadPersistence {
	let data = initial;
	return {
		load: async () => data,
		mutate: async (fn) => {
			data = fn(data);
			return data;
		},
	};
}

function makeStore(overrides: Partial<ConstructorParameters<typeof HomeThreadStore>[0]> = {}) {
	const persistence = overrides.persistence ?? inMemoryPersistence();
	let counter = 0;
	const store = new HomeThreadStore({
		workspaceId: "workspace-1",
		persistence,
		now: () => 1000,
		generateId: () => {
			counter += 1;
			return `thread-${counter}`;
		},
		...overrides,
	});
	return { store, persistence };
}

describe("HomeThreadStore", () => {
	it("creates a thread with a generated id and returns it (default manual title)", async () => {
		const { store } = makeStore();
		const thread = await store.create({ agentId: "pi", name: "Planning" });
		expect(thread).toEqual({
			id: "thread-1",
			agentId: "pi",
			name: "Planning",
			titleSource: "manual",
			createdAt: 1000,
			updatedAt: 1000,
		});
		expect(await store.list()).toHaveLength(1);
	});

	it("creates a thread carrying the requested titleSource", async () => {
		const { store } = makeStore();
		const thread = await store.create({ agentId: "claude", name: "Provisional", titleSource: "auto" });
		expect(thread.titleSource).toBe("auto");
	});

	it("honors a client-supplied id instead of generating one", async () => {
		const { store } = makeStore();
		const thread = await store.create({ agentId: "claude", name: "Preseeded", id: "client-uuid" });
		expect(thread.id).toBe("client-uuid");
		// A later close derives the session id (and thus the attachments scope) from this id.
		const closed = await store.close("client-uuid");
		expect(closed.id).toBe("client-uuid");
	});

	it("renames a thread and pins it manual", async () => {
		const { store } = makeStore();
		const created = await store.create({ agentId: "pi", name: "Old", titleSource: "auto" });
		const renamed = await store.rename(created.id, "New");
		expect(renamed.name).toBe("New");
		expect(renamed.titleSource).toBe("manual");
	});

	it("sets an auto title when not pinned, and skips a pinned manual title", async () => {
		const { store } = makeStore();
		const auto = await store.create({ agentId: "claude", name: "Provisional", titleSource: "auto" });
		const applied = await store.setAutoTitle(auto.id, "Concise summary");
		expect(applied.applied).toBe(true);
		expect(applied.thread.name).toBe("Concise summary");
		expect(applied.thread.titleSource).toBe("auto");

		const manual = await store.create({ agentId: "codex", name: "Named by user" });
		const skipped = await store.setAutoTitle(manual.id, "Agent title");
		expect(skipped.applied).toBe(false);
		expect(skipped.thread.name).toBe("Named by user");
	});

	it("sets and clears a thread's pending next-step suggestion", async () => {
		const { store } = makeStore();
		const created = await store.create({ agentId: "pi", name: "Planning" });

		const withSuggestion = await store.setNextStep(created.id, "Start the top backlog task");
		expect(withSuggestion.pendingNextStep).toBe("Start the top backlog task");
		expect((await store.list()).find((t) => t.id === created.id)?.pendingNextStep).toBe("Start the top backlog task");

		const cleared = await store.setNextStep(created.id, null);
		expect(cleared.pendingNextStep).toBeNull();
	});

	it("closes a thread and cleans up the derived session via onCloseSession", async () => {
		const onCloseSession = vi.fn(async () => undefined);
		const { store } = makeStore({ onCloseSession });
		const created = await store.create({ agentId: "claude", name: "Temp" });

		const removed = await store.close(created.id);

		expect(removed.id).toBe(created.id);
		expect(await store.list()).toHaveLength(0);
		// Non-default thread id => four-segment session id.
		expect(onCloseSession).toHaveBeenCalledWith(`__home_agent__:workspace-1:claude:${created.id}`);
	});

	it("blocks a hard close while the thread still has open origin tasks, and does not remove it or touch the session", async () => {
		const onCloseSession = vi.fn(async () => undefined);
		const getOpenOriginTasks = vi.fn(async () => [
			{ id: "task-a", title: "Wire the API" },
			{ id: "task-b", title: "Add the button" },
		]);
		const { store } = makeStore({ onCloseSession, getOpenOriginTasks });
		const created = await store.create({ agentId: "pi", name: "Busy" });

		await expect(store.close(created.id)).rejects.toBeInstanceOf(HomeThreadCloseBlockedError);

		// The thread survives and the backing session is never cleaned up.
		expect(await store.list()).toHaveLength(1);
		expect(onCloseSession).not.toHaveBeenCalled();
		expect(getOpenOriginTasks).toHaveBeenCalledWith(created.id);
	});

	it("reports the count of unfinished tasks in the block error", async () => {
		const getOpenOriginTasks = vi.fn(async () => [
			{ id: "task-a", title: "Wire the API" },
			{ id: "task-b", title: "Add the button" },
		]);
		const { store } = makeStore({ getOpenOriginTasks });
		const created = await store.create({ agentId: "pi", name: "Busy" });

		const error = await store.close(created.id).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(HomeThreadCloseBlockedError);
		const blocked = error as HomeThreadCloseBlockedError;
		expect(blocked.openTasks).toHaveLength(2);
		expect(blocked.message).toContain("2");
	});

	it("allows a hard close when the thread has no open origin tasks", async () => {
		const onCloseSession = vi.fn(async () => undefined);
		const getOpenOriginTasks = vi.fn(async () => []);
		const { store } = makeStore({ onCloseSession, getOpenOriginTasks });
		const created = await store.create({ agentId: "pi", name: "Idle" });

		const removed = await store.close(created.id);

		expect(removed.id).toBe(created.id);
		expect(await store.list()).toHaveLength(0);
		expect(onCloseSession).toHaveBeenCalledTimes(1);
	});

	describe("IM channel binding", () => {
		it("binds a thread to an IM channel and reflects it in getImChannel + list", async () => {
			const { store } = makeStore();
			const created = await store.create({ agentId: "pi", name: "Bindable" });

			const bound = await store.bindImChannel(created.id, { platform: "lark", chatId: "oc_abc" });

			expect(bound.imChannel).toEqual({ platform: "lark", chatId: "oc_abc" });
			expect(await store.getImChannel(created.id)).toEqual({ platform: "lark", chatId: "oc_abc" });
			expect((await store.list())[0]?.imChannel).toEqual({ platform: "lark", chatId: "oc_abc" });
		});

		it("unbinds a thread's IM channel", async () => {
			const { store } = makeStore();
			const created = await store.create({ agentId: "pi", name: "Bindable" });
			await store.bindImChannel(created.id, { platform: "dingtalk", chatId: "cid_1" });

			const unbound = await store.unbindImChannel(created.id);

			expect(unbound.imChannel).toBeNull();
			expect(await store.getImChannel(created.id)).toBeNull();
		});

		it("returns null from getImChannel for an unbound or unknown thread", async () => {
			const { store } = makeStore();
			const created = await store.create({ agentId: "pi", name: "Unbound" });
			expect(await store.getImChannel(created.id)).toBeNull();
			expect(await store.getImChannel("does-not-exist")).toBeNull();
		});

		it("throws when binding a thread that does not exist", async () => {
			const { store } = makeStore();
			await expect(store.bindImChannel("missing", { platform: "lark", chatId: "x" })).rejects.toThrow();
		});

		it("moves an IM channel off the previous thread when bound to a new one (one-to-one)", async () => {
			const { store } = makeStore();
			const first = await store.create({ agentId: "pi", name: "First" });
			const second = await store.create({ agentId: "claude", name: "Second" });
			await store.bindImChannel(first.id, { platform: "lark", chatId: "oc_shared" });

			const moved = await store.bindImChannel(second.id, { platform: "lark", chatId: "oc_shared" });

			expect(moved.imChannel).toEqual({ platform: "lark", chatId: "oc_shared" });
			expect(await store.getImChannel(second.id)).toEqual({ platform: "lark", chatId: "oc_shared" });
			// The previous owner is now unbound — an IM chat maps to at most one thread.
			expect(await store.getImChannel(first.id)).toBeNull();
		});
	});

	it("lists threads sorted by creation time", async () => {
		const persistence = inMemoryPersistence({
			threads: [
				{ id: "b", agentId: "pi", name: "B", titleSource: "manual", createdAt: 200, updatedAt: 200 },
				{ id: "a", agentId: "pi", name: "A", titleSource: "manual", createdAt: 100, updatedAt: 100 },
			],
		});
		const { store } = makeStore({ persistence });
		expect((await store.list()).map((t) => t.id)).toEqual(["a", "b"]);
	});
});
