// Bounds the per-message content shipped to chat surfaces.
//
// A transcript can accumulate pathologically large individual messages — e.g. a
// `search_files`/tool result that matched a giant or minified file and captured
// multiple megabytes into one `content` string. Those messages dominate the
// page-open cost of `getTaskChatMessages`: the runtime must serialize the whole
// array to the wire, ship it, and the client must parse and render it on every
// open. A single 12 MB message turns a ~100 KB transcript into a ~25 MB payload.
//
// This cap is a pure, display-only projection applied at the transport boundary
// (the `getTaskChatMessages` handler). It keeps the head of an oversized message
// (enough to see what it was) and replaces the tail with a short marker, flagging
// `meta.contentTruncated` so a surface can offer to fetch the full content later.
// The on-disk journal and the in-memory buffer keep the full content — only the
// transported copy is bounded — so correctness, streaming, and restart-history
// persistence are unaffected.
import type { SessionMessage } from "./session-message";

// 64 KiB comfortably preserves every realistic message (long assistant turns,
// file reads, normal tool results) intact while clamping runaway multi-MB blobs.
export const MAX_DISPLAY_CONTENT_CHARS = 64 * 1024;

function truncationMarker(originalLength: number): string {
	const omittedKib = Math.round((originalLength - MAX_DISPLAY_CONTENT_CHARS) / 1024);
	return `\n\n…[truncated ${omittedKib.toLocaleString()} KB — full content omitted to keep chat fast]`;
}

function capMessage(message: SessionMessage): SessionMessage {
	if (message.content.length <= MAX_DISPLAY_CONTENT_CHARS) {
		return message;
	}
	const originalLength = message.content.length;
	return {
		...message,
		content: message.content.slice(0, MAX_DISPLAY_CONTENT_CHARS) + truncationMarker(originalLength),
		meta: {
			...(message.meta ?? {}),
			contentTruncated: true,
			originalContentLength: originalLength,
		},
	};
}

/**
 * Return a transport-safe copy of `messages` with any oversized message content
 * truncated. Messages under the cap are returned by reference (and the input
 * array itself is returned unchanged when nothing needs capping), so the common
 * case allocates nothing and the merge cache's reference identity is preserved.
 */
export function capChatMessagesForTransport(messages: SessionMessage[]): SessionMessage[] {
	let result = messages;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) {
			continue;
		}
		const capped = capMessage(message);
		if (capped !== message) {
			if (result === messages) {
				result = [...messages];
			}
			result[index] = capped;
		}
	}
	return result;
}
