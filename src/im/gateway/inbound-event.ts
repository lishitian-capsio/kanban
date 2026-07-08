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
 * The business payload carried by an interactive-card interaction (a button click, a select, …).
 * Kept platform-neutral: `value` is the element's carried business data (Lark `action.value`,
 * DingTalk's parsed callback params), which a future consumer maps to a board command.
 */
export interface ImInboundCardAction {
	/** The element's carried value. `{}` when the element clicked carried no business value. */
	value: Record<string, unknown>;
	/** The element tag when the platform provides one (Lark `"button"`/`"select_static"`/…). */
	tag?: string;
}

/**
 * A button / element interaction on an interactive card, received over the long connection (Lark
 * `card.action.trigger`, DingTalk Stream card callback). Normalized into the neutral shape the
 * routing / 闭环 layer consumes — it never touches a platform SDK type.
 */
export interface ImInboundCardActionEvent {
	kind: "card_action";
	/** The platform the connection belongs to. */
	platform: ImPlatform;
	/**
	 * The platform-native chat / conversation id the card lives in (Lark `context.open_chat_id`,
	 * DingTalk `conversationId`). `""` when the platform omits it (some card callbacks are
	 * card-instance-centric); a consumer can then fall back to {@link cardRef}.
	 */
	channelKey: string;
	/** The platform-native id of the operator who interacted (Lark `operator.open_id`, DingTalk `userId`). */
	senderId: string;
	/** The interaction's business payload. */
	action: ImInboundCardAction;
	/**
	 * A token for asynchronously updating the card after the interaction (Lark's event-level
	 * callback `token`, DingTalk's `outTrackId`). Optional — absent when the platform omits it.
	 */
	callbackToken?: string;
	/** Reference to the card instance / message for an in-place update (Lark `open_message_id`, DingTalk `outTrackId`). */
	cardRef?: string;
	/**
	 * A stable per-interaction identity for idempotent dedup (Lark header `event_id`, DingTalk a
	 * composite of `outTrackId` + the action value). Optional for the same reason as on a message
	 * event; the routing layer's `(platform, messageId)` guard applies when present.
	 */
	messageId?: string;
}

/**
 * The normalized inbound event the gateway delivers to its subscribers. A discriminated union so
 * new inbound kinds (approval events, …) can be added later without changing the emit / subscribe
 * contract — consumers switch on {@link ImInboundEvent.kind}.
 */
export type ImInboundEvent = ImInboundMessageEvent | ImInboundCardActionEvent;
