import { describe, expect, it, vi } from "vitest";
import type { ImInboundEvent } from "../../../src/im/gateway/inbound-event";
import { ImChatInboundRecorder } from "../../../src/im/im-chat-recorder";
import type { ImChannelTarget, ImPlatform } from "../../../src/im/types";

function messageEvent(overrides: Partial<Extract<ImInboundEvent, { kind: "message" }>> = {}): ImInboundEvent {
	return {
		kind: "message",
		platform: "lark",
		channelKey: "oc_1",
		text: "@bot hello",
		senderId: "u_1",
		...overrides,
	};
}

/** Await queued microtasks so the recorder's fire-and-forget record promises settle. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ImChatInboundRecorder", () => {
	it("records an inbound message channel into every managed workspace", async () => {
		const calls: Array<{ workspaceId: string; channel: ImChannelTarget }> = [];
		const recorder = new ImChatInboundRecorder({
			listWorkspaceIds: () => ["ws-a", "ws-b"],
			recordInbound: async (workspaceId, channel) => {
				calls.push({ workspaceId, channel });
			},
		});
		recorder.handleInboundEvent(messageEvent({ platform: "dingtalk", channelKey: "cid_7" }));
		await flush();
		expect(calls).toEqual([
			{ workspaceId: "ws-a", channel: { platform: "dingtalk", chatId: "cid_7" } },
			{ workspaceId: "ws-b", channel: { platform: "dingtalk", chatId: "cid_7" } },
		]);
	});

	it("ignores non-message events", async () => {
		const recordInbound = vi.fn(async () => {});
		const recorder = new ImChatInboundRecorder({ listWorkspaceIds: () => ["ws-a"], recordInbound });
		// A future event kind the recorder must not react to.
		recorder.handleInboundEvent({ kind: "other" } as unknown as ImInboundEvent);
		await flush();
		expect(recordInbound).not.toHaveBeenCalled();
	});

	it("dedupes repeat chatter per (workspace, platform, chatId) after a successful record", async () => {
		const recordInbound = vi.fn(async () => {});
		const recorder = new ImChatInboundRecorder({ listWorkspaceIds: () => ["ws-a"], recordInbound });
		recorder.handleInboundEvent(messageEvent());
		await flush();
		recorder.handleInboundEvent(messageEvent());
		recorder.handleInboundEvent(messageEvent());
		await flush();
		expect(recordInbound).toHaveBeenCalledTimes(1);
	});

	it("retries on the next message when a record fails (does not mark seen)", async () => {
		let attempt = 0;
		const recordInbound = vi.fn(async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new Error("transient");
			}
		});
		const recorder = new ImChatInboundRecorder({ listWorkspaceIds: () => ["ws-a"], recordInbound });
		recorder.handleInboundEvent(messageEvent());
		await flush();
		recorder.handleInboundEvent(messageEvent());
		await flush();
		expect(recordInbound).toHaveBeenCalledTimes(2);
	});

	it("records into a newly-opened workspace even for a previously-seen chat", async () => {
		const seen: string[] = [];
		let workspaces = ["ws-a"];
		const recorder = new ImChatInboundRecorder({
			listWorkspaceIds: () => workspaces,
			recordInbound: async (workspaceId) => {
				seen.push(workspaceId);
			},
		});
		recorder.handleInboundEvent(messageEvent());
		await flush();
		workspaces = ["ws-a", "ws-b"];
		recorder.handleInboundEvent(messageEvent());
		await flush();
		expect(seen).toEqual(["ws-a", "ws-b"]);
	});

	it("evicts oldest seen keys past the capacity so it never grows unbounded", async () => {
		const recordInbound = vi.fn(async () => {});
		const recorder = new ImChatInboundRecorder({
			listWorkspaceIds: () => ["ws-a"],
			recordInbound,
			seenCapacity: 2,
		});
		const platforms: ImPlatform[] = ["lark", "dingtalk"];
		// Fill capacity with two distinct chats, then a third evicts the first.
		recorder.handleInboundEvent(messageEvent({ platform: platforms[0], channelKey: "c1" }));
		recorder.handleInboundEvent(messageEvent({ platform: platforms[0], channelKey: "c2" }));
		await flush();
		recorder.handleInboundEvent(messageEvent({ platform: platforms[0], channelKey: "c3" }));
		await flush();
		// c1 was evicted, so a repeat re-records it.
		recorder.handleInboundEvent(messageEvent({ platform: platforms[0], channelKey: "c1" }));
		await flush();
		expect(recordInbound).toHaveBeenCalledTimes(4);
	});
});
