import { describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { ImTaskEventNotifier, type ImTaskEventNotifierDeps, type ImTaskRoute } from "../../../src/im/im-task-notifier";
import type { ImCard, ImChannelTarget, ImSendResult, ImTextMessage } from "../../../src/im/types";

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/repo",
		pid: 123,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

const channel: ImChannelTarget = { platform: "lark", chatId: "oc_room" };

function makeNotifier(overrides: Partial<ImTaskEventNotifierDeps> = {}) {
	const sendText = vi.fn<(target: ImChannelTarget, message: ImTextMessage) => Promise<ImSendResult | null>>(
		async () => ({
			platform: "lark",
			chatId: channel.chatId,
		}),
	);
	const sendCard = vi.fn<(target: ImChannelTarget, card: ImCard) => Promise<ImSendResult | null>>(async () => ({
		platform: "lark",
		chatId: channel.chatId,
	}));
	const resolveTaskRoute = vi.fn<(workspaceId: string, taskId: string) => Promise<ImTaskRoute | null>>(async () => ({
		originThreadId: "thread-1",
		title: "Fix login",
	}));
	const resolveThreadImChannel = vi.fn<(workspaceId: string, threadId: string) => Promise<ImChannelTarget | null>>(
		async () => channel,
	);
	const notifier = new ImTaskEventNotifier({
		resolveTaskRoute,
		resolveThreadImChannel,
		sendText,
		sendCard,
		...overrides,
	});
	return { notifier, sendText, sendCard, resolveTaskRoute, resolveThreadImChannel };
}

/** Drain the fire-and-forget async dispatch scheduled by handleTransition. */
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("ImTaskEventNotifier routing", () => {
	it("routes an awaiting_review(hook) transition through originThreadId -> imChannel as a card", async () => {
		const { notifier, sendCard, resolveTaskRoute, resolveThreadImChannel } = makeNotifier();
		notifier.handleTransition("ws-1", summary({ state: "running", reviewReason: null }), summary());
		await flush();
		expect(resolveTaskRoute).toHaveBeenCalledWith("ws-1", "task-1");
		expect(resolveThreadImChannel).toHaveBeenCalledWith("ws-1", "thread-1");
		expect(sendCard).toHaveBeenCalledTimes(1);
		const firstCall = sendCard.mock.calls[0];
		if (!firstCall) {
			throw new Error("expected sendCard to have been called");
		}
		const [target, card] = firstCall;
		expect(target).toEqual(channel);
		expect(card.text).toContain("Fix login");
	});

	it("routes a complete (exit) transition as text", async () => {
		const { notifier, sendText, sendCard } = makeNotifier();
		notifier.handleTransition(
			"ws-1",
			summary({ state: "running", reviewReason: null }),
			summary({ reviewReason: "exit", updatedAt: 5 }),
		);
		await flush();
		expect(sendText).toHaveBeenCalledTimes(1);
		expect(sendCard).not.toHaveBeenCalled();
	});

	it("skips when the task has no origin thread", async () => {
		const { notifier, sendCard, sendText, resolveThreadImChannel } = makeNotifier({
			resolveTaskRoute: async () => null,
		});
		notifier.handleTransition("ws-1", summary({ state: "running", reviewReason: null }), summary());
		await flush();
		expect(resolveThreadImChannel).not.toHaveBeenCalled();
		expect(sendCard).not.toHaveBeenCalled();
		expect(sendText).not.toHaveBeenCalled();
	});

	it("skips when the thread is not bound to an IM channel", async () => {
		const { notifier, sendCard, sendText } = makeNotifier({
			resolveThreadImChannel: async () => null,
		});
		notifier.handleTransition("ws-1", summary({ state: "running", reviewReason: null }), summary());
		await flush();
		expect(sendCard).not.toHaveBeenCalled();
		expect(sendText).not.toHaveBeenCalled();
	});

	it("does not emit for a non-high-signal transition", async () => {
		const { notifier, resolveTaskRoute, sendCard, sendText } = makeNotifier();
		// running -> idle is not high-signal
		notifier.handleTransition(
			"ws-1",
			summary({ state: "running", reviewReason: null }),
			summary({ state: "idle", reviewReason: null }),
		);
		await flush();
		expect(resolveTaskRoute).not.toHaveBeenCalled();
		expect(sendCard).not.toHaveBeenCalled();
		expect(sendText).not.toHaveBeenCalled();
	});

	it("swallows dispatch failures (send failure degrades to logging)", async () => {
		const { notifier } = makeNotifier({
			sendCard: async () => {
				throw new Error("network down");
			},
		});
		expect(() =>
			notifier.handleTransition("ws-1", summary({ state: "running", reviewReason: null }), summary()),
		).not.toThrow();
		await flush();
	});
});

describe("ImTaskEventNotifier dedup (at-least-once idempotency)", () => {
	function running(): RuntimeTaskSessionSummary {
		return summary({ state: "running", reviewReason: null });
	}

	it("delivers the same edge only once even when the transition fires twice", async () => {
		const { notifier, sendCard } = makeNotifier();
		const prev = running();
		const next = summary({ updatedAt: 42 });
		notifier.handleTransition("ws-1", prev, next);
		notifier.handleTransition("ws-1", prev, next);
		await flush();
		expect(sendCard).toHaveBeenCalledTimes(1);
	});

	it("treats a later edge (new updatedAt) as a distinct event", async () => {
		const { notifier, sendCard } = makeNotifier();
		notifier.handleTransition("ws-1", running(), summary({ updatedAt: 42 }));
		await flush();
		// task goes back to running, then into review again with a fresh updatedAt
		notifier.handleTransition("ws-1", running(), summary({ updatedAt: 99 }));
		await flush();
		expect(sendCard).toHaveBeenCalledTimes(2);
	});

	it("does not confuse the same edge across different workspaces", async () => {
		const { notifier, sendCard } = makeNotifier();
		notifier.handleTransition("ws-1", running(), summary({ updatedAt: 42 }));
		notifier.handleTransition("ws-2", running(), summary({ updatedAt: 42 }));
		await flush();
		expect(sendCard).toHaveBeenCalledTimes(2);
	});

	it("evicts old dedup keys past capacity so it never grows unbounded", async () => {
		const { notifier, sendCard } = makeNotifier({ dedupCapacity: 2 });
		const prev = running();
		notifier.handleTransition("ws-1", prev, summary({ taskId: "a", updatedAt: 1 }));
		notifier.handleTransition("ws-1", prev, summary({ taskId: "b", updatedAt: 1 }));
		notifier.handleTransition("ws-1", prev, summary({ taskId: "c", updatedAt: 1 }));
		await flush();
		expect(sendCard).toHaveBeenCalledTimes(3);
		// "a" was evicted, so replaying it sends again
		notifier.handleTransition("ws-1", prev, summary({ taskId: "a", updatedAt: 1 }));
		await flush();
		expect(sendCard).toHaveBeenCalledTimes(4);
	});
});
