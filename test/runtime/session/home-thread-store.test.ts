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
});
