import { describe, expect, it, vi } from "vitest";
import type { RuntimeImChatsData } from "../../../src/core/api-contract";
import { ImChatStore } from "../../../src/session/im-chat-store";

function createStore(now?: () => number): { store: ImChatStore; writes: () => number } {
	let data: RuntimeImChatsData = { chats: [] };
	let writeCount = 0;
	const store = new ImChatStore({
		now,
		persistence: {
			load: async () => data,
			mutate: async (fn) => {
				const next = fn(data);
				// Mirror the on-disk content-compare: a same-reference return is not a write.
				if (next !== data) {
					writeCount += 1;
					data = next;
				}
				return data;
			},
		},
	});
	return { store, writes: () => writeCount };
}

describe("ImChatStore", () => {
	it("adds a manual chat and lists it", async () => {
		const { store } = createStore(() => 42);
		const chat = await store.add({ platform: "lark", chatId: "oc_1", displayName: "群" });
		expect(chat).toMatchObject({ platform: "lark", chatId: "oc_1", displayName: "群", source: "manual" });
		expect(await store.list()).toHaveLength(1);
	});

	it("upserts on re-add rather than duplicating", async () => {
		const { store } = createStore();
		await store.add({ platform: "lark", chatId: "oc_1", displayName: "old" });
		await store.add({ platform: "lark", chatId: "oc_1", displayName: "new" });
		const chats = await store.list();
		expect(chats).toHaveLength(1);
		expect(chats[0]?.displayName).toBe("new");
	});

	it("removes a chat by identity", async () => {
		const { store } = createStore();
		await store.add({ platform: "dingtalk", chatId: "cid_1" });
		const removed = await store.remove("dingtalk", "cid_1");
		expect(removed.chatId).toBe("cid_1");
		expect(await store.list()).toHaveLength(0);
	});

	it("rejects removing a missing chat", async () => {
		const { store } = createStore();
		await expect(store.remove("lark", "missing")).rejects.toThrow(/not found/);
	});

	it("records a new inbound chat and returns the entry", async () => {
		const { store } = createStore();
		const created = await store.recordInbound({ platform: "lark", chatId: "oc_9" });
		expect(created).toMatchObject({ source: "inbound", chatId: "oc_9" });
		expect(await store.list()).toHaveLength(1);
	});

	it("recordInbound is a no-op (returns null, no write) for a known chat", async () => {
		const { store, writes } = createStore();
		await store.recordInbound({ platform: "lark", chatId: "oc_9" });
		const writesAfterFirst = writes();
		const second = await store.recordInbound({ platform: "lark", chatId: "oc_9" });
		expect(second).toBeNull();
		expect(writes()).toBe(writesAfterFirst);
	});

	it("recordInbound never clobbers a manual entry", async () => {
		const { store } = createStore();
		await store.add({ platform: "lark", chatId: "oc_1", displayName: "manual label" });
		const result = await store.recordInbound({ platform: "lark", chatId: "oc_1" });
		expect(result).toBeNull();
		const chats = await store.list();
		expect(chats[0]).toMatchObject({ source: "manual", displayName: "manual label" });
	});

	it("uses the injected clock for timestamps", async () => {
		const now = vi.fn(() => 777);
		const { store } = createStore(now);
		const chat = await store.add({ platform: "lark", chatId: "oc_1" });
		expect(chat.createdAt).toBe(777);
		expect(chat.updatedAt).toBe(777);
	});
});
