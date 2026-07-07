import { describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../../src/core/api-contract";
import { createHomeAgentSessionId } from "../../../../src/core/home-agent-session";
import {
	ImChatReplyNotifier,
	type ImChatReplyNotifierDeps,
} from "../../../../src/im/inbound/im-chat-reply-notifier";
import type { SessionMessage } from "../../../../src/session/session-message";
import type { ImChannelTarget, ImSendResult, ImTextMessage } from "../../../../src/im/types";

const HOME_TASK_ID = createHomeAgentSessionId("ws-a", "pi", "thread-1");
const channel: ImChannelTarget = { platform: "lark", chatId: "oc_room" };

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: HOME_TASK_ID,
		state: "awaiting_review",
		agentId: "pi",
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

function assistantMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
	return { id: "m1", role: "assistant", content: "the answer", createdAt: 1, ...overrides };
}

function makeNotifier(overrides: Partial<ImChatReplyNotifierDeps> = {}) {
	const sendText = vi.fn<(target: ImChannelTarget, message: ImTextMessage) => Promise<ImSendResult | null>>(
		async () => ({ platform: "lark", chatId: channel.chatId }),
	);
	const resolveThreadImChannel = vi.fn<(workspaceId: string, threadId: string) => Promise<ImChannelTarget | null>>(
		async () => channel,
	);
	const notifier = new ImChatReplyNotifier({ resolveThreadImChannel, sendText, ...overrides });
	return { notifier, sendText, resolveThreadImChannel };
}

/** Drain the fire-and-forget async flush scheduled by noteTransition. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ImChatReplyNotifier", () => {
	it("flushes the buffered assistant reply to the bound channel on running → awaiting_review", async () => {
		const { notifier, sendText, resolveThreadImChannel } = makeNotifier();
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage({ content: "hello from pi" }));
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "awaiting_review" }));
		await flush();
		expect(resolveThreadImChannel).toHaveBeenCalledWith("ws-a", "thread-1");
		expect(sendText).toHaveBeenCalledWith(channel, { text: "hello from pi" });
	});

	it("also flushes on running → idle", async () => {
		const { notifier, sendText } = makeNotifier();
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage());
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "idle" }));
		await flush();
		expect(sendText).toHaveBeenCalledTimes(1);
	});

	it("uses the latest streamed content for a coalesced message id", async () => {
		const { notifier, sendText } = makeNotifier();
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage({ id: "m1", content: "par" }));
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage({ id: "m1", content: "partial answer" }));
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "awaiting_review" }));
		await flush();
		expect(sendText).toHaveBeenCalledWith(channel, { text: "partial answer" });
	});

	it("does not flush without a turn-completing transition", async () => {
		const { notifier, sendText } = makeNotifier();
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage());
		// idle → running is the start of a turn, not its completion.
		notifier.noteTransition("ws-a", summary({ state: "idle" }), summary({ state: "running" }));
		await flush();
		expect(sendText).not.toHaveBeenCalled();
	});

	it("does not flush when there is no buffered assistant message", async () => {
		const { notifier, sendText } = makeNotifier();
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "awaiting_review" }));
		await flush();
		expect(sendText).not.toHaveBeenCalled();
	});

	it("skips an empty / whitespace-only assistant reply", async () => {
		const { notifier, sendText } = makeNotifier();
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage({ content: "   " }));
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "awaiting_review" }));
		await flush();
		expect(sendText).not.toHaveBeenCalled();
	});

	it("skips when the thread is not bound to any channel", async () => {
		const { notifier, sendText } = makeNotifier({ resolveThreadImChannel: async () => null });
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage());
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "awaiting_review" }));
		await flush();
		expect(sendText).not.toHaveBeenCalled();
	});

	it("ignores non-home sessions and non-assistant roles", async () => {
		const { notifier, sendText } = makeNotifier();
		const realTaskId = "task-42";
		notifier.noteMessage("ws-a", realTaskId, assistantMessage());
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage({ role: "user", content: "user text" }));
		notifier.noteTransition(
			"ws-a",
			summary({ taskId: realTaskId, state: "running" }),
			summary({ taskId: realTaskId, state: "awaiting_review" }),
		);
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "awaiting_review" }));
		await flush();
		expect(sendText).not.toHaveBeenCalled();
	});

	it("dedups so a re-observed transition does not double-send the same reply", async () => {
		const { notifier, sendText } = makeNotifier();
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage({ id: "m1" }));
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "awaiting_review" }));
		await flush();
		// Same message buffered again + another completing transition → already sent.
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage({ id: "m1" }));
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "idle" }));
		await flush();
		expect(sendText).toHaveBeenCalledTimes(1);
	});

	it("sends a fresh reply (new message id) on the next turn", async () => {
		const { notifier, sendText } = makeNotifier();
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage({ id: "m1", content: "first" }));
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "awaiting_review" }));
		await flush();
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage({ id: "m2", content: "second" }));
		notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "awaiting_review" }));
		await flush();
		expect(sendText).toHaveBeenCalledTimes(2);
		expect(sendText).toHaveBeenLastCalledWith(channel, { text: "second" });
	});

	it("never throws out of noteTransition when the send fails", async () => {
		const { notifier } = makeNotifier({
			sendText: async () => {
				throw new Error("network down");
			},
		});
		notifier.noteMessage("ws-a", HOME_TASK_ID, assistantMessage());
		expect(() =>
			notifier.noteTransition("ws-a", summary({ state: "running" }), summary({ state: "awaiting_review" })),
		).not.toThrow();
		await expect(flush()).resolves.toBeUndefined();
	});
});
