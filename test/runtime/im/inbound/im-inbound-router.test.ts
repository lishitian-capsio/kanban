import { describe, expect, it, vi } from "vitest";
import type { ImInboundEvent } from "../../../../src/im/gateway/inbound-event";
import type { ImThreadBinding } from "../../../../src/im/im-task-route-resolver";
import { type ImInboundDelivery, ImInboundRouter } from "../../../../src/im/inbound/im-inbound-router";
import type { ImPlatform } from "../../../../src/im/types";

function messageEvent(overrides: Partial<Extract<ImInboundEvent, { kind: "message" }>> = {}): ImInboundEvent {
	return {
		kind: "message",
		platform: "lark",
		channelKey: "oc_1",
		text: "hello",
		senderId: "u_1",
		messageId: "evt-1",
		...overrides,
	};
}

/** Await queued microtasks so the router's fire-and-forget route promises settle. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ImInboundRouter", () => {
	it("resolves the binding then delivers text + images to the bound thread", async () => {
		const deliveries: ImInboundDelivery[] = [];
		const router = new ImInboundRouter({
			resolveBinding: async () => ({ workspaceId: "ws-a", threadId: "t-b", agentId: "pi" }),
			deliver: async (delivery) => {
				deliveries.push(delivery);
			},
		});
		const images = [{ mimeType: "image/png", dataBase64: "AAAA" }];
		router.handleInboundEvent(messageEvent({ text: "route me", images }));
		await flush();
		expect(deliveries).toEqual([
			{ workspaceId: "ws-a", binding: { threadId: "t-b", agentId: "pi" }, text: "route me", images },
		]);
	});

	it("passes the inbound (platform, chatId) to the binding resolver", async () => {
		const resolveBinding = vi.fn<[ImPlatform, string], Promise<({ workspaceId: string } & ImThreadBinding) | null>>(
			async () => null,
		);
		const router = new ImInboundRouter({ resolveBinding, deliver: async () => {} });
		router.handleInboundEvent(messageEvent({ platform: "dingtalk", channelKey: "cid_7" }));
		await flush();
		expect(resolveBinding).toHaveBeenCalledWith("dingtalk", "cid_7");
	});

	it("drops a message whose chat is not bound to any thread", async () => {
		const deliver = vi.fn(async () => {});
		const router = new ImInboundRouter({ resolveBinding: async () => null, deliver });
		router.handleInboundEvent(messageEvent());
		await flush();
		expect(deliver).not.toHaveBeenCalled();
	});

	it("ignores non-message events", async () => {
		const deliver = vi.fn(async () => {});
		const router = new ImInboundRouter({
			resolveBinding: async () => ({ workspaceId: "ws-a", threadId: "t", agentId: "pi" }),
			deliver,
		});
		router.handleInboundEvent({ kind: "other" } as unknown as ImInboundEvent);
		await flush();
		expect(deliver).not.toHaveBeenCalled();
	});

	it("dedups a redelivered messageId (delivers once)", async () => {
		const deliver = vi.fn(async () => {});
		const router = new ImInboundRouter({
			resolveBinding: async () => ({ workspaceId: "ws-a", threadId: "t", agentId: "pi" }),
			deliver,
		});
		router.handleInboundEvent(messageEvent({ messageId: "evt-dup" }));
		await flush();
		router.handleInboundEvent(messageEvent({ messageId: "evt-dup" }));
		router.handleInboundEvent(messageEvent({ messageId: "evt-dup" }));
		await flush();
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("treats the same messageId on different platforms as distinct", async () => {
		const deliver = vi.fn(async () => {});
		const router = new ImInboundRouter({
			resolveBinding: async () => ({ workspaceId: "ws-a", threadId: "t", agentId: "pi" }),
			deliver,
		});
		router.handleInboundEvent(messageEvent({ platform: "lark", messageId: "x" }));
		router.handleInboundEvent(messageEvent({ platform: "dingtalk", messageId: "x" }));
		await flush();
		expect(deliver).toHaveBeenCalledTimes(2);
	});

	it("does not dedup events without a messageId", async () => {
		const deliver = vi.fn(async () => {});
		const router = new ImInboundRouter({
			resolveBinding: async () => ({ workspaceId: "ws-a", threadId: "t", agentId: "pi" }),
			deliver,
		});
		router.handleInboundEvent(messageEvent({ messageId: undefined }));
		router.handleInboundEvent(messageEvent({ messageId: undefined }));
		await flush();
		expect(deliver).toHaveBeenCalledTimes(2);
	});

	it("swallows a resolver/delivery failure (never throws into the gateway)", async () => {
		const router = new ImInboundRouter({
			resolveBinding: async () => ({ workspaceId: "ws-a", threadId: "t", agentId: "pi" }),
			deliver: async () => {
				throw new Error("boom");
			},
		});
		expect(() => router.handleInboundEvent(messageEvent())).not.toThrow();
		await expect(flush()).resolves.toBeUndefined();
	});

	it("evicts oldest dedup keys past capacity so it never grows unbounded", async () => {
		const deliver = vi.fn(async () => {});
		const router = new ImInboundRouter({
			resolveBinding: async () => ({ workspaceId: "ws-a", threadId: "t", agentId: "pi" }),
			deliver,
			dedupCapacity: 2,
		});
		router.handleInboundEvent(messageEvent({ messageId: "m1" }));
		router.handleInboundEvent(messageEvent({ messageId: "m2" }));
		await flush();
		router.handleInboundEvent(messageEvent({ messageId: "m3" })); // evicts m1
		await flush();
		router.handleInboundEvent(messageEvent({ messageId: "m1" })); // no longer seen → delivered again
		await flush();
		expect(deliver).toHaveBeenCalledTimes(4);
	});
});
