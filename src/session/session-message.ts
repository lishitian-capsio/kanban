// Agent-agnostic session message model.
//
// This is the shared transcript primitive for every agent runtime — pi's rich
// structure (user/assistant/tool/reasoning/system/status) and the lighter CLI
// agent transcripts (per-turn assistant text blocks) both express themselves as
// `SessionMessage[]`. CLI captures need only emit `assistant` (and `user`) roles
// with text content; the richer roles and `meta` fields stay optional.
//
// The model is intentionally anchored to the websocket contract type
// (`runtimeTaskChatMessageSchema` in api-contract). The wire schema is the
// source of truth, so the in-memory model and the `task_chat_message` broadcast
// payload can never drift apart.
import type { RuntimeTaskChatMessage, RuntimeTaskImage } from "../core/api-contract";

export type SessionMessage = RuntimeTaskChatMessage;
export type SessionMessageRole = SessionMessage["role"];
export type SessionMessageMeta = NonNullable<SessionMessage["meta"]>;

export function now(): number {
	return Date.now();
}

export function createSessionMessage(
	taskId: string,
	role: SessionMessageRole,
	content: string,
	images?: RuntimeTaskImage[],
): SessionMessage {
	return {
		id: `${taskId}-${now()}-${Math.random().toString(36).slice(2, 8)}`,
		role,
		content,
		images: images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined,
		createdAt: now(),
	};
}

export function createSessionMessageWithMeta(
	taskId: string,
	role: SessionMessageRole,
	content: string,
	meta: SessionMessage["meta"],
	images?: RuntimeTaskImage[],
): SessionMessage {
	return {
		...createSessionMessage(taskId, role, content, images),
		meta,
	};
}

export function cloneSessionMessage(message: SessionMessage): SessionMessage {
	return {
		...message,
		images: message.images ? message.images.map((image) => ({ ...image })) : message.images,
		meta: message.meta ? { ...message.meta } : message.meta,
	};
}
