import { describe, expect, it, vi } from "vitest";

import type { RuntimeHomeChatThreadsData } from "../../../src/core/api-contract";
import { type HomeThreadPersistence, HomeThreadStore } from "../../../src/session/home-thread-store";

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
	it("creates a thread with a generated id and returns it", async () => {
		const { store } = makeStore();
		const thread = await store.create({ agentId: "pi", name: "Planning" });
		expect(thread).toEqual({
			id: "thread-1",
			agentId: "pi",
			name: "Planning",
			createdAt: 1000,
			updatedAt: 1000,
		});
		expect(await store.list()).toHaveLength(1);
	});

	it("renames a thread", async () => {
		const { store } = makeStore();
		const created = await store.create({ agentId: "pi", name: "Old" });
		const renamed = await store.rename(created.id, "New");
		expect(renamed.name).toBe("New");
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

	it("lists threads sorted by creation time", async () => {
		const persistence = inMemoryPersistence({
			threads: [
				{ id: "b", agentId: "pi", name: "B", createdAt: 200, updatedAt: 200 },
				{ id: "a", agentId: "pi", name: "A", createdAt: 100, updatedAt: 100 },
			],
		});
		const { store } = makeStore({ persistence });
		expect((await store.list()).map((t) => t.id)).toEqual(["a", "b"]);
	});

	describe("resolveTaskThread", () => {
		it("resolves to the implicit default thread without creating one", async () => {
			const { store } = makeStore();
			const result = await store.resolveTaskThread({
				origin: { agentId: "pi", threadId: "default" },
				fallbackAgentId: "claude",
				fallbackName: "Ask",
			});
			expect(result).toEqual({
				sessionId: "__home_agent__:workspace-1:pi",
				agentId: "pi",
				threadId: "default",
				created: false,
			});
			expect(await store.list()).toHaveLength(0);
		});

		it("resolves to an existing registered thread using its registered agent", async () => {
			const persistence = inMemoryPersistence({
				threads: [{ id: "t-existing", agentId: "claude", name: "Chat", createdAt: 100, updatedAt: 100 }],
			});
			const { store } = makeStore({ persistence });
			const result = await store.resolveTaskThread({
				origin: { agentId: "pi", threadId: "t-existing" },
				fallbackAgentId: "pi",
				fallbackName: "Ask",
			});
			expect(result).toEqual({
				sessionId: "__home_agent__:workspace-1:claude:t-existing",
				agentId: "claude",
				threadId: "t-existing",
				created: false,
			});
		});

		it("creates a fresh thread bound to the task when there is no origin", async () => {
			const { store } = makeStore();
			const result = await store.resolveTaskThread({
				origin: null,
				fallbackAgentId: "claude",
				fallbackName: "Ask · task-123",
			});
			expect(result).toEqual({
				sessionId: "__home_agent__:workspace-1:claude:thread-1",
				agentId: "claude",
				threadId: "thread-1",
				created: true,
			});
			const threads = await store.list();
			expect(threads).toHaveLength(1);
			expect(threads[0]).toMatchObject({ id: "thread-1", agentId: "claude", name: "Ask · task-123" });
		});

		it("creates a fresh thread bound to the original agent when the origin thread was closed", async () => {
			const { store } = makeStore();
			const result = await store.resolveTaskThread({
				origin: { agentId: "pi", threadId: "closed-thread" },
				fallbackAgentId: "claude",
				fallbackName: "Ask",
			});
			// Prefer the original kanban agent over the workspace fallback so the user
			// keeps talking to the same agent that created the task.
			expect(result).toEqual({
				sessionId: "__home_agent__:workspace-1:pi:thread-1",
				agentId: "pi",
				threadId: "thread-1",
				created: true,
			});
		});
	});
});
