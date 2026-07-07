/**
 * Normalized inbound events delivered through the IM gateway's unified callback seam.
 *
 * A per-platform long-connection connector (Lark WebSocket / DingTalk Stream) decodes its
 * platform-native frames into one of these neutral events and pushes it into the gateway
 * (`ImConnectorContext.emit`). The gateway fans events out to its subscribers
 * (`ImGateway.onInboundEvent`) — the routing / agent-wake layer that consumes them lives in a
 * later task, so this type is intentionally the smallest shape that lets a connector be written
 * and a consumer subscribe. The discriminated `kind` keeps it extensible (card actions, approval
 * events, …) without breaking either side.
 */
import type { ImPlatform } from "../types";

/**
 * An image attached to an inbound message. The connector downloads the platform image and encodes
 * its bytes so the consumer can forward them to a vision-capable agent without any platform SDK.
 */
export interface ImInboundImage {
	/** MIME type of the image, e.g. `"image/png"`. */
	mimeType: string;
	/** Base64-encoded image bytes. */
	dataBase64: string;
}

/** A user message received from a bound IM channel over the long connection. */
export interface ImInboundMessageEvent {
	kind: "message";
	/** The platform the connection belongs to. */
	platform: ImPlatform;
	/**
	 * The platform-native chat / conversation identifier (Lark `chat_id`, DingTalk
	 * `conversationId`). The routing layer maps this to a session binding.
	 */
	channelKey: string;
	/** The plain-text body of the message. */
	text: string;
	/** The platform-native id of the sender. */
	senderId: string;
	/** Images the message carried, when any. */
	images?: ImInboundImage[];
	/**
	 * A stable per-message identity used by the routing layer for idempotent dedup
	 * (the platform's `event_id` / `msgId`). Connectors already collapse at-least-once
	 * redeliveries at their own layer, so this is a secondary guard; it is optional
	 * because a platform frame may omit it (dedup is simply skipped when absent).
	 */
	messageId?: string;
}

/**
 * The normalized inbound event the gateway delivers to its subscribers. A discriminated union so
 * new inbound kinds (card button callbacks, approval events) can be added later without changing
 * the emit / subscribe contract — consumers switch on {@link ImInboundEvent.kind}.
 */
export type ImInboundEvent = ImInboundMessageEvent;
