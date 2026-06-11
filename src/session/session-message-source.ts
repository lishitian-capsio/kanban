// Agent-agnostic contract for anything that owns a session transcript and can
// stream it to subscribers (e.g. the runtime websocket hub).
//
// `PiTaskSessionService` implements this today; a future terminal/CLI session
// service can implement the same surface so the broadcast layer stays agnostic
// to which agent produced the messages.
import type { SessionMessage } from "./session-message";

export type SessionMessageListener = (taskId: string, message: SessionMessage) => void;

export interface SessionMessageSource {
	/** Subscribe to live messages as they are appended/updated. Returns an unsubscribe fn. */
	onMessage(listener: SessionMessageListener): () => void;
	/** Snapshot of the in-memory transcript for a task. */
	listMessages(taskId: string): SessionMessage[];
	/** Resolve the transcript for a task, hydrating from persistence when available. */
	loadTaskSessionMessages(taskId: string): Promise<SessionMessage[]>;
}
