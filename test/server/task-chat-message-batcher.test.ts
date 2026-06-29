import { describe, expect, it } from "vitest";
import { createTaskChatMessageBatcher } from "../../src/server/task-chat-message-batcher";
import type { SessionMessage } from "../../src/session/session-message";

function msg(id: string, content: string, role: SessionMessage["role"] = "assistant"): SessionMessage {
	return { id, role, content, createdAt: 0 };
}

interface FakeClock {
	advance: (ms: number) => void;
	setTimer: (cb: () => void, ms: number) => number;
	clearTimer: (handle: unknown) => void;
}

function createFakeClock(): FakeClock {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { fireAt: number; cb: () => void }>();
	return {
		advance(ms) {
			now += ms;
			for (const [id, timer] of [...timers.entries()]) {
				if (timer.fireAt <= now) {
					timers.delete(id);
					timer.cb();
				}
			}
		},
		setTimer(cb, ms) {
			const id = nextId++;
			timers.set(id, { fireAt: now + ms, cb });
			return id;
		},
		clearTimer(handle) {
			timers.delete(handle as number);
		},
	};
}

describe("createTaskChatMessageBatcher", () => {
	it("coalesces repeated updates to the same message id into one flush", () => {
		const clock = createFakeClock();
		const flushes: Array<{ taskId: string; messages: SessionMessage[] }> = [];
		const batcher = createTaskChatMessageBatcher({
			batchMs: 50,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			flush: (batch) => flushes.push({ taskId: batch.taskId, messages: batch.messages }),
		});

		batcher.enqueue("ws", "t1", msg("m1", "He"));
		batcher.enqueue("ws", "t1", msg("m1", "Hello"));
		batcher.enqueue("ws", "t1", msg("m1", "Hello world"));
		expect(flushes).toHaveLength(0); // nothing sent before the batch window elapses

		clock.advance(50);
		expect(flushes).toHaveLength(1);
		expect(flushes[0]?.messages).toHaveLength(1);
		expect(flushes[0]?.messages[0]?.content).toBe("Hello world"); // only the latest text
	});

	it("preserves every distinct message id in insertion order", () => {
		const clock = createFakeClock();
		const flushes: Array<{ messages: SessionMessage[] }> = [];
		const batcher = createTaskChatMessageBatcher({
			batchMs: 50,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			flush: (batch) => flushes.push({ messages: batch.messages }),
		});

		batcher.enqueue("ws", "t1", msg("u1", "question", "user"));
		batcher.enqueue("ws", "t1", msg("a1", "answer", "assistant"));
		batcher.enqueue("ws", "t1", msg("a1", "answer final", "assistant"));
		batcher.enqueue("ws", "t1", msg("tool1", "tool", "tool"));
		clock.advance(50);

		expect(flushes).toHaveLength(1);
		expect(flushes[0]?.messages.map((m) => m.id)).toEqual(["u1", "a1", "tool1"]);
		expect(flushes[0]?.messages.find((m) => m.id === "a1")?.content).toBe("answer final");
	});

	it("isolates batches per task so one task's stream never delays another's flush", () => {
		const clock = createFakeClock();
		const flushes: Array<{ taskId: string }> = [];
		const batcher = createTaskChatMessageBatcher({
			batchMs: 50,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			flush: (batch) => flushes.push({ taskId: batch.taskId }),
		});

		batcher.enqueue("ws", "t1", msg("m1", "a"));
		batcher.enqueue("ws", "t2", msg("m2", "b"));
		clock.advance(50);
		expect(flushes.map((f) => f.taskId).sort()).toEqual(["t1", "t2"]);
	});

	it("disposeWorkspace drops pending batches and cancels timers for that workspace only", () => {
		const clock = createFakeClock();
		const flushes: string[] = [];
		const batcher = createTaskChatMessageBatcher({
			batchMs: 50,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			flush: (batch) => flushes.push(batch.workspaceId),
		});

		batcher.enqueue("ws-a", "t1", msg("m1", "a"));
		batcher.enqueue("ws-b", "t2", msg("m2", "b"));
		batcher.disposeWorkspace("ws-a");
		clock.advance(50);
		expect(flushes).toEqual(["ws-b"]);
	});
});
