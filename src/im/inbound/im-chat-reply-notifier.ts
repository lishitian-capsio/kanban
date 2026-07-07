/**
 * Pushes a home thread's agent reply back to the IM chat it is bound to (requirement ac99c, task
 * I2 — the outbound half of inbound routing). It reuses the SAME transcript stream the runtime
 * broadcasts to web clients over `task_chat_message`, so an IM-driven turn and a browser-driven
 * turn produce identical replies.
 *
 * A pi assistant message is re-emitted on every streamed token (same message id), so forwarding
 * per message would spam the chat. Instead this buffers the latest assistant text per home session
 * ({@link noteMessage}) and flushes exactly once when the turn completes — the session-summary
 * transition into a settled state ({@link noteTransition}, `running → awaiting_review | idle`). The
 * buffered text is sent to the thread's bound IM channel, then cleared.
 *
 * Idempotent: a bounded FIFO of sent `(taskId, messageId)` keys means a re-observed transition (or
 * a message id that flushes twice) never double-sends. Both entry points are synchronous +
 * fire-and-forget; a resolve/send failure degrades to a log line and never affects the runtime's
 * state broadcasts. Non-home sessions and non-assistant roles are ignored.
 */
import type { RuntimeTaskSessionSummary } from "../../core/api-contract";
import { isHomeAgentSessionId, parseHomeAgentSessionId } from "../../core/home-agent-session";
import { createLogger } from "../../logging";
import type { SessionMessage } from "../../session/session-message";
import { sendImText } from "../im-dispatch";
import type { ImChannelTarget, ImSendResult, ImTextMessage } from "../types";

const log = createLogger("im.chat-reply");

const DEFAULT_DEDUP_CAPACITY = 1000;

/** The last assistant message seen for a home session, coalesced by message id across tokens. */
interface BufferedReply {
	messageId: string;
	content: string;
}

export interface ImChatReplyNotifierDeps {
	/**
	 * Resolve the IM channel a home session's reply should be pushed to. Dispatches on the agent:
	 * Pi's binding is doc-level (decision X1), a thread's is on its entry — so the agent is required
	 * to keep a browser-driven CLI default session (threadId `"default"`, unbound) from mis-routing
	 * to Pi's channel. Returns `null` when unbound (→ skip).
	 */
	resolveThreadImChannel: (workspaceId: string, agentId: string, threadId: string) => Promise<ImChannelTarget | null>;
	/** Outbound text sender; defaults to the runtime-safe {@link sendImText}. Injected in tests. */
	sendText?: (target: ImChannelTarget, message: ImTextMessage) => Promise<ImSendResult | null>;
	/** Max sent `(taskId, messageId)` keys retained before FIFO eviction. */
	dedupCapacity?: number;
}

export class ImChatReplyNotifier {
	private readonly resolveThreadImChannel: ImChatReplyNotifierDeps["resolveThreadImChannel"];
	private readonly sendText: NonNullable<ImChatReplyNotifierDeps["sendText"]>;
	private readonly dedupCapacity: number;
	/** Latest assistant reply per home session task id, awaiting a turn-completion flush. */
	private readonly pending = new Map<string, BufferedReply>();
	private readonly sent = new Set<string>();
	private readonly sentOrder: string[] = [];

	constructor(deps: ImChatReplyNotifierDeps) {
		this.resolveThreadImChannel = deps.resolveThreadImChannel;
		this.sendText = deps.sendText ?? sendImText;
		this.dedupCapacity = deps.dedupCapacity && deps.dedupCapacity > 0 ? deps.dedupCapacity : DEFAULT_DEDUP_CAPACITY;
	}

	/**
	 * Observe a transcript message. Buffers the latest assistant text for a home session so the
	 * turn-completion flush can forward it. Streaming re-emits the same id → last content wins.
	 */
	noteMessage(_workspaceId: string, taskId: string, message: SessionMessage): void {
		if (!isHomeAgentSessionId(taskId) || message.role !== "assistant") {
			return;
		}
		this.pending.set(taskId, { messageId: message.id, content: message.content });
	}

	/**
	 * Observe a session-summary transition. When a home session's turn just completed
	 * (`running → awaiting_review | idle`), flush its buffered assistant reply to the bound IM
	 * channel. Synchronous + fire-and-forget.
	 */
	noteTransition(
		workspaceId: string,
		previous: RuntimeTaskSessionSummary | null,
		next: RuntimeTaskSessionSummary,
	): void {
		if (!isHomeAgentSessionId(next.taskId)) {
			return;
		}
		const turnCompleted =
			previous?.state === "running" && (next.state === "awaiting_review" || next.state === "idle");
		if (!turnCompleted) {
			return;
		}
		const reply = this.pending.get(next.taskId);
		if (!reply || reply.content.trim().length === 0) {
			return;
		}
		this.pending.delete(next.taskId);
		const dedupKey = `${next.taskId} ${reply.messageId}`;
		if (this.sent.has(dedupKey)) {
			return;
		}
		this.remember(dedupKey);
		void this.flush(workspaceId, next.taskId, reply.content);
	}

	private async flush(workspaceId: string, taskId: string, content: string): Promise<void> {
		try {
			const parsed = parseHomeAgentSessionId(taskId);
			if (!parsed) {
				return;
			}
			const channel = await this.resolveThreadImChannel(workspaceId, parsed.agentId, parsed.threadId);
			if (!channel) {
				return;
			}
			await this.sendText(channel, { text: content });
		} catch (error) {
			log.warn("failed to push home thread reply to IM", { workspaceId, taskId, error });
		}
	}

	private remember(key: string): void {
		this.sent.add(key);
		this.sentOrder.push(key);
		if (this.sentOrder.length > this.dedupCapacity) {
			const evicted = this.sentOrder.shift();
			if (evicted !== undefined) {
				this.sent.delete(evicted);
			}
		}
	}
}
