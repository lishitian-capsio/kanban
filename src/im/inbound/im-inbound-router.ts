/**
 * Routes an inbound IM message to the home thread bound to its chat (requirement ac99c, task I2).
 *
 * Flow per inbound `message` event: dedup (idempotent) → resolve the (platform, chatId) → home
 * thread binding → deliver the text/images into that thread's agent (waking or continuing it). A
 * chat that no thread is bound to is silently dropped — binding is a deliberate per-workspace user
 * action, and the {@link ../im-chat-recorder ImChatInboundRecorder} has already surfaced the chat
 * as a bindable candidate.
 *
 * `handleInboundEvent` is synchronous + fire-and-forget: the gateway's fan-out must not block on a
 * board read / session start / process launch, and any failure degrades to a log line — a broken
 * binding or a failed agent start must never wedge the resident gateway or its other connections.
 *
 * Idempotent, at-least-once: the platform (and its connector) may re-deliver the same message, so a
 * bounded FIFO dedup set keyed on `(platform, messageId)` collapses duplicates before any delivery.
 * The connectors already dedup their own redeliveries; this is a secondary guard that also covers a
 * redelivery slipping past a connector recreated on reconnect. Events without a `messageId` skip
 * dedup (nothing stable to key on) and are delivered — the connector remains the primary guard.
 */
import { createLogger } from "../../logging";
import type { ImInboundEvent, ImInboundImage } from "../gateway/inbound-event";
import type { ImThreadBinding } from "../im-task-route-resolver";
import type { ImPlatform } from "../types";

const log = createLogger("im.inbound-router");

const DEFAULT_DEDUP_CAPACITY = 2000;

/** A resolved delivery: the workspace + thread the inbound chat routes to, plus what to deliver. */
export interface ImInboundDelivery {
	workspaceId: string;
	binding: ImThreadBinding;
	text: string;
	images?: ImInboundImage[];
}

export interface ImInboundRouterDeps {
	/**
	 * Resolve which workspace + home thread an inbound chat is bound to. Returns `null` when no
	 * thread is bound to that (platform, chatId) → the message is dropped. Wired to a scan over the
	 * runtime's managed workspaces' threads docs.
	 */
	resolveBinding: (
		platform: ImPlatform,
		chatId: string,
	) => Promise<({ workspaceId: string } & ImThreadBinding) | null>;
	/**
	 * Deliver the message into the resolved thread's agent (pi structured input / CLI PTY), starting
	 * or continuing the session as needed. Resolves when handed off; rejects on a genuine failure
	 * (surfaced as a log line, never thrown to the gateway).
	 */
	deliver: (delivery: ImInboundDelivery) => Promise<void>;
	/** Max `(platform, messageId)` dedup keys retained before FIFO eviction. */
	dedupCapacity?: number;
}

export class ImInboundRouter {
	private readonly resolveBinding: ImInboundRouterDeps["resolveBinding"];
	private readonly deliver: ImInboundRouterDeps["deliver"];
	private readonly dedupCapacity: number;
	private readonly seen = new Set<string>();
	private readonly seenOrder: string[] = [];

	constructor(deps: ImInboundRouterDeps) {
		this.resolveBinding = deps.resolveBinding;
		this.deliver = deps.deliver;
		this.dedupCapacity = deps.dedupCapacity && deps.dedupCapacity > 0 ? deps.dedupCapacity : DEFAULT_DEDUP_CAPACITY;
	}

	/** Subscribe this to {@link ImGateway.onInboundEvent}. Non-message events are ignored. */
	handleInboundEvent(event: ImInboundEvent): void {
		if (event.kind !== "message") {
			return;
		}
		// Dedup synchronously — before any async work — so a rapid redelivery is dropped up front.
		if (event.messageId !== undefined) {
			const dedupKey = `${event.platform} ${event.messageId}`;
			if (this.seen.has(dedupKey)) {
				return;
			}
			this.remember(dedupKey);
		}
		void this.route(event.platform, event.channelKey, event.text, event.images);
	}

	private async route(
		platform: ImPlatform,
		chatId: string,
		text: string,
		images: ImInboundImage[] | undefined,
	): Promise<void> {
		try {
			const binding = await this.resolveBinding(platform, chatId);
			if (!binding) {
				// No home thread bound to this chat — nothing to route to.
				return;
			}
			await this.deliver({
				workspaceId: binding.workspaceId,
				binding: { threadId: binding.threadId, agentId: binding.agentId },
				text,
				images,
			});
		} catch (error) {
			log.warn("failed to route inbound IM message to a home thread", { platform, error });
		}
	}

	private remember(key: string): void {
		this.seen.add(key);
		this.seenOrder.push(key);
		if (this.seenOrder.length > this.dedupCapacity) {
			const evicted = this.seenOrder.shift();
			if (evicted !== undefined) {
				this.seen.delete(evicted);
			}
		}
	}
}
