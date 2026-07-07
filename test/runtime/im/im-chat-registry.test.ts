import { describe, expect, it } from "vitest";
import type { RuntimeImChatsData } from "../../../src/core/api-contract";
import {
	listImChats,
	recordInboundImChat,
	removeImChat,
	upsertManualImChat,
} from "../../../src/session/im-chat-registry";

function emptyData(): RuntimeImChatsData {
	return { chats: [] };
}

describe("im-chat-registry", () => {
	describe("upsertManualImChat", () => {
		it("inserts a new manual entry with the supplied display name", () => {
			const { next, chat } = upsertManualImChat(emptyData(), {
				platform: "lark",
				chatId: "oc_1",
				displayName: "团队群",
				now: 100,
			});
			expect(chat).toEqual({
				platform: "lark",
				chatId: "oc_1",
				displayName: "团队群",
				source: "manual",
				createdAt: 100,
				updatedAt: 100,
			});
			expect(next.chats).toHaveLength(1);
		});

		it("defaults display name to empty when omitted", () => {
			const { chat } = upsertManualImChat(emptyData(), { platform: "dingtalk", chatId: "cid_1", now: 1 });
			expect(chat.displayName).toBe("");
		});

		it("updates an existing entry in place, bumping updatedAt and keeping createdAt", () => {
			const first = upsertManualImChat(emptyData(), {
				platform: "lark",
				chatId: "oc_1",
				displayName: "old",
				now: 100,
			});
			const second = upsertManualImChat(first.next, {
				platform: "lark",
				chatId: "oc_1",
				displayName: "new",
				now: 200,
			});
			expect(second.next.chats).toHaveLength(1);
			expect(second.chat).toMatchObject({ displayName: "new", createdAt: 100, updatedAt: 200 });
		});

		it("keeps the existing display name when a re-add omits one", () => {
			const first = upsertManualImChat(emptyData(), {
				platform: "lark",
				chatId: "oc_1",
				displayName: "keep me",
				now: 100,
			});
			const second = upsertManualImChat(first.next, { platform: "lark", chatId: "oc_1", now: 200 });
			expect(second.chat.displayName).toBe("keep me");
		});

		it("promotes an inbound-discovered entry to manual on manual add", () => {
			const inbound = recordInboundImChat(emptyData(), { platform: "lark", chatId: "oc_1", now: 100 });
			if (!inbound) {
				throw new Error("expected the inbound record to insert");
			}
			expect(inbound.chat.source).toBe("inbound");
			const manual = upsertManualImChat(inbound.next, {
				platform: "lark",
				chatId: "oc_1",
				displayName: "named",
				now: 200,
			});
			expect(manual.chat).toMatchObject({ source: "manual", displayName: "named", createdAt: 100 });
		});

		it("treats the same chatId on different platforms as distinct entries", () => {
			const first = upsertManualImChat(emptyData(), { platform: "lark", chatId: "same", now: 1 });
			const second = upsertManualImChat(first.next, { platform: "dingtalk", chatId: "same", now: 2 });
			expect(second.next.chats).toHaveLength(2);
		});
	});

	describe("recordInboundImChat", () => {
		it("inserts a new inbound entry when absent", () => {
			const result = recordInboundImChat(emptyData(), { platform: "dingtalk", chatId: "cid_9", now: 5 });
			expect(result).not.toBeNull();
			expect(result?.chat).toMatchObject({ source: "inbound", chatId: "cid_9", displayName: "" });
		});

		it("is a no-op (returns null) when the chat already exists", () => {
			const first = recordInboundImChat(emptyData(), { platform: "lark", chatId: "oc_1", now: 1 });
			if (!first) {
				throw new Error("expected the first inbound record to insert");
			}
			const again = recordInboundImChat(first.next, { platform: "lark", chatId: "oc_1", now: 2 });
			expect(again).toBeNull();
		});

		it("never clobbers a manual entry (returns null, leaves label/source intact)", () => {
			const manual = upsertManualImChat(emptyData(), {
				platform: "lark",
				chatId: "oc_1",
				displayName: "user label",
				now: 1,
			});
			const inbound = recordInboundImChat(manual.next, { platform: "lark", chatId: "oc_1", now: 2 });
			expect(inbound).toBeNull();
			expect(manual.next.chats[0]).toMatchObject({ source: "manual", displayName: "user label" });
		});
	});

	describe("removeImChat", () => {
		it("removes the matching entry and returns it", () => {
			const added = upsertManualImChat(emptyData(), { platform: "lark", chatId: "oc_1", now: 1 });
			const { next, removed } = removeImChat(added.next, "lark", "oc_1");
			expect(removed.chatId).toBe("oc_1");
			expect(next.chats).toHaveLength(0);
		});

		it("throws when the entry is missing", () => {
			expect(() => removeImChat(emptyData(), "lark", "nope")).toThrow(/not found/);
		});

		it("only removes the matching (platform, chatId)", () => {
			const a = upsertManualImChat(emptyData(), { platform: "lark", chatId: "same", now: 1 });
			const b = upsertManualImChat(a.next, { platform: "dingtalk", chatId: "same", now: 2 });
			const { next } = removeImChat(b.next, "lark", "same");
			expect(next.chats).toHaveLength(1);
			expect(next.chats[0]).toMatchObject({ platform: "dingtalk" });
		});
	});

	describe("listImChats", () => {
		it("orders most-recently-updated first, stable tiebreak on chatId", () => {
			let data = emptyData();
			data = upsertManualImChat(data, { platform: "lark", chatId: "b", now: 100 }).next;
			data = upsertManualImChat(data, { platform: "lark", chatId: "a", now: 300 }).next;
			data = upsertManualImChat(data, { platform: "lark", chatId: "c", now: 300 }).next;
			expect(listImChats(data).map((c) => c.chatId)).toEqual(["a", "c", "b"]);
		});

		it("does not mutate the input array", () => {
			const data = upsertManualImChat(emptyData(), { platform: "lark", chatId: "a", now: 1 }).next;
			const original = data.chats;
			listImChats(data);
			expect(data.chats).toBe(original);
		});
	});
});
