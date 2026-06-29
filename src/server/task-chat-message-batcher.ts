import type { SessionMessage } from "../session/session-message";

/**
 * Batches `task_chat_message` broadcasts so a streaming agent reply does not
 * re-broadcast the entire accumulated message on every token.
 *
 * pi (and the terminal capture) re-emit the **same** assistant message id with
 * the full text-so-far on each `message_update`. Sending each one immediately is
 * O(n^2) bytes per reply and one `JSON.stringify` per token on the runtime's
 * event loop. The batcher coalesces by message id within a `(workspaceId,
 * taskId)` pair over a short window, so a long stream collapses to one send per
 * window carrying only the latest text. Distinct ids (the user prompt, a tool
 * call, a new assistant turn) are all preserved in arrival order, so no message
 * is ever dropped — only intermediate frames of the same message are. The
 * frontend reconciles by id, so dropping intermediate frames is safe.
 */
export interface TaskChatMessageBatch {
	workspaceId: string;
	taskId: string;
	messages: SessionMessage[];
}

export interface CreateTaskChatMessageBatcherOptions {
	/** Debounce window per `(workspaceId, taskId)` before a flush fires. */
	batchMs: number;
	/** Called once per window with the coalesced, order-preserved messages. */
	flush: (batch: TaskChatMessageBatch) => void;
	/** Injectable timer (defaults to an unref'd `setTimeout`) — lets tests drive a fake clock. */
	setTimer?: (callback: () => void, ms: number) => TaskChatBatchTimer;
	clearTimer?: (handle: TaskChatBatchTimer) => void;
}

// The injected fake clock uses `number` handles; the real timer uses
// `setTimeout`'s return. `unknown` keeps the seam honest without an `any`.
export type TaskChatBatchTimer = unknown;

export interface TaskChatMessageBatcher {
	enqueue: (workspaceId: string, taskId: string, message: SessionMessage) => void;
	/** Drop pending batches + cancel timers for one workspace (on workspace dispose). */
	disposeWorkspace: (workspaceId: string) => void;
	/** Drop all pending batches + cancel all timers (on hub close). */
	dispose: () => void;
}

interface PendingChatBatch {
	workspaceId: string;
	taskId: string;
	// Insertion-ordered: re-`set`ting an existing id keeps its position, so the
	// flushed order matches first-seen order while content tracks the latest.
	messagesById: Map<string, SessionMessage>;
	timer: TaskChatBatchTimer;
}

function batchKey(workspaceId: string, taskId: string): string {
	// `workspaceId` carries the entry's own copy too, so this key only needs to be
	// unique; the JSON-encoded pair can never collide across distinct inputs.
	return JSON.stringify([workspaceId, taskId]);
}

export function createTaskChatMessageBatcher(options: CreateTaskChatMessageBatcherOptions): TaskChatMessageBatcher {
	const setTimer =
		options.setTimer ??
		((callback, ms) => {
			const timer = setTimeout(callback, ms);
			timer.unref();
			return timer;
		});
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

	const pendingByKey = new Map<string, PendingChatBatch>();

	const flushKey = (key: string): void => {
		const pending = pendingByKey.get(key);
		if (!pending) {
			return;
		}
		pendingByKey.delete(key);
		options.flush({
			workspaceId: pending.workspaceId,
			taskId: pending.taskId,
			messages: Array.from(pending.messagesById.values()),
		});
	};

	const enqueue = (workspaceId: string, taskId: string, message: SessionMessage): void => {
		const key = batchKey(workspaceId, taskId);
		const existing = pendingByKey.get(key);
		if (existing) {
			existing.messagesById.set(message.id, message);
			return;
		}
		const messagesById = new Map<string, SessionMessage>();
		messagesById.set(message.id, message);
		const timer = setTimer(() => flushKey(key), options.batchMs);
		pendingByKey.set(key, { workspaceId, taskId, messagesById, timer });
	};

	const disposeWorkspace = (workspaceId: string): void => {
		// Compare the entry's own workspaceId (not a key prefix) so this is robust
		// regardless of how keys are encoded.
		for (const [key, pending] of [...pendingByKey.entries()]) {
			if (pending.workspaceId === workspaceId) {
				clearTimer(pending.timer);
				pendingByKey.delete(key);
			}
		}
	};

	const dispose = (): void => {
		for (const pending of pendingByKey.values()) {
			clearTimer(pending.timer);
		}
		pendingByKey.clear();
	};

	return { enqueue, disposeWorkspace, dispose };
}
