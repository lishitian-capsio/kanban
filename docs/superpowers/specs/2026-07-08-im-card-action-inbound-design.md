# IM card-action callbacks over the long connection

Requirement ac99c (IM Home 绑定), ④ 闭环入站的第一半：把互动卡片按钮回调接入现有长连接入站通道，归一成 gateway 的统一"卡片动作"事件供上层消费。幂等去重。

## Background

The resident `ImGateway` (043ba) supervises one long connection per credentialed platform and fans normalized inbound events out to subscribers. Today both connectors decode exactly one event kind — `im.message.receive_v1` (Lark, 078cd) / `/v1.0/im/bot/messages/get` (DingTalk Stream, 06c08) — into `ImInboundMessageEvent`. The neutral event type (`src/im/gateway/inbound-event.ts`) is already a discriminated union whose doc comment explicitly reserves room for "card actions, approval events" without changing the emit/subscribe contract.

`im-bridge-design.md` §7.4 (④ 闭环卡片动作) and its `NormalizedInboundEvent` sketch already anticipate a `card_action` kind: user clicks a card button → platform callback → adapter normalizes to `{ kind: "card_action", action, cardRef, … }` → gateway → a consumer maps `action` to a board command.

## Scope

**In scope (this task):** receive interactive-card button callbacks on both long connections, normalize to ONE neutral gateway event, dedup idempotently, emit through the existing gateway fan-out.

**Out of scope (deliberately deferred):**
- The consumer that maps a card action → board command (`resolveCardAction`, ④ 闭环) — a later task. `ImInboundRouter` already early-returns on any non-`message` event, so it needs no change.
- Card *sending*/rendering (outbound `NormalizedCard` → platform JSON) — DingTalk card sending is not yet built at all; Lark card sending is a separate concern.
- Approval events (`kind: "approval"`).

## The neutral event

Extend the union in `src/im/gateway/inbound-event.ts`:

```ts
/** The business payload carried by an interactive-card interaction. */
export interface ImInboundCardAction {
	/** The element's carried value (Lark `action.value` object, DingTalk parsed callback params). */
	value: Record<string, unknown>;
	/** The element tag when the platform provides one (Lark "button"/"select_static"/…); DingTalk omits it. */
	tag?: string;
}

/** A button/element interaction on an interactive card delivered over the long connection. */
export interface ImInboundCardActionEvent {
	kind: "card_action";
	platform: ImPlatform;
	/** Platform-native chat id (Lark `context.open_chat_id`, DingTalk `conversationId`); "" when the platform omits it. */
	channelKey: string;
	/** Operator id (Lark `operator.open_id`→union→user, DingTalk `userId`/staff id). */
	senderId: string;
	action: ImInboundCardAction;
	/** Token to asynchronously update the card after the interaction (Lark event-level `token`; DingTalk `outTrackId`). */
	callbackToken?: string;
	/** Reference to the card instance/message for in-place update (Lark `context.open_message_id`, DingTalk `outTrackId`). */
	cardRef?: string;
	/** Stable id for idempotent dedup (Lark header `event_id`, DingTalk `card:<outTrackId>:<valueHash>`). */
	messageId?: string;
}

export type ImInboundEvent = ImInboundMessageEvent | ImInboundCardActionEvent;
```

`value` is `Record<string, unknown>` (not a string) because both platforms carry structured action payloads; the future consumer picks a discriminant field out of it. Nothing here binds to a platform SDK type.

## Lark: `card.action.trigger`

**SDK support (verified against `@larksuiteoapi/node-sdk` lib):** card action callbacks flow over the same `WSClient` as messages. `WSClient.handleEventData` calls `eventDispatcher.invoke(mergedData, { needCheck: false })` for every `MessageType.event` frame and sends the handler's return value back as the callback response (base64 JSON `respPayload.data`). The base `EventDispatcher`'s `RequestHandle.parse` treats `card.action.trigger` as a v2 event (`'schema' in data`): it sets the event type from `header.event_type` and merges `{ ...rest, ...header, ...event }` flat. So a handler registered under `"card.action.trigger"` receives a flat object with header fields (`event_id`, `create_time`, …) and event fields (`operator`, `action`, `context`, `host`, and the event-level `token`, which overrides the header verification `token` in the merge). Returning `undefined` ⇒ empty 200 ⇒ no card update (correct for this task — updating the card is the future consumer's job).

**Transport** (`lark-inbound-transport.ts`): add `onCardAction(data: unknown)` to `LarkInboundTransportHandlers`; register `card.action.trigger` on the `EventDispatcher` alongside `im.message.receive_v1`, forwarding merged data to `handlers.onCardAction`. The handler returns nothing.

**Pure normalizer** (`lark-inbound-message.ts`, new `normalizeLarkCardAction(data): NormalizedLarkCardAction | null`): read defensively from `unknown`:
- `channelKey` ← `context.open_chat_id` (fallback `""`).
- `senderId` ← reuse `extractSenderId`-style logic on `operator` (`open_id`→`union_id`→`user_id`).
- `action.value` ← `action.value` when it is a record, else `{}`; `action.tag` ← string when present.
- `callbackToken` ← top-level `token` (event-level callback token).
- `cardRef` ← `context.open_message_id`.
- Returns `null` only when the payload is not a record or has no `action` object at all (an action with an empty value but a tag is still deliverable — a tagged button with no business value is a legitimate click).

`parseLarkInboundEventId(data)` (existing) reads the merged `event_id` — reused as the dedup id, identically to the message path.

**Connector** (`lark-inbound-connector.ts`): add a `connect` wiring for `onCardAction`; in a new `handleCardAction(data)`: dedup on `event_id` via the existing `seenEventIds` FIFO (shared with messages — Lark `event_id`s are globally unique across event types), normalize, and `emit` an `ImInboundCardActionEvent` with `messageId = event_id`. Downloading images is irrelevant here, so this path is synchronous.

## DingTalk: Stream card callback

DingTalk's Stream-mode interactive-card / AI-card button callback is delivered on the CALLBACK topic **`/v1.0/card/instances/callback`** (the Stream equivalent of the ActionCard callback). The exact `data` field names are doc-derived and marked for live verification, mirroring the existing "单聊 / image download = deliberate later extension" notes on this connector — the decode is fully defensive so an unexpected shape is skipped, never thrown.

**Protocol** (`dingtalk-stream-protocol.ts`):
- New const `DINGTALK_CARD_CALLBACK_TOPIC = "/v1.0/card/instances/callback"`.
- `buildDingtalkOpenRequest` subscribes to BOTH the bot-message topic and the card-callback topic (`subscriptions: [{type:"CALLBACK", topic: BOT_MESSAGE}, {type:"CALLBACK", topic: CARD_CALLBACK}]`).
- `isDingtalkCardCallbackFrame(frame)` → `frame.topic === DINGTALK_CARD_CALLBACK_TOPIC`.
- New pure `decodeDingtalkCardAction(dataJson): DecodedDingtalkCardAction | null`:
  - `outTrackId` (card instance id) → `cardRef` + `callbackToken`.
  - `userId` (staff id) → `senderId`; `null`-skip when absent.
  - `conversationId` when present → `channelKey`, else `""` (card callbacks are card-instance-centric; the future consumer can resolve via `outTrackId`).
  - `content` is a JSON string carrying the interaction params; parse it defensively and expose the inner params object (e.g. `cardPrivateData.params`, falling back to the whole parsed object) as `action.value`.
  - `dedupKey` = `card:<outTrackId>:<serialized value>` so different buttons on one card are not collapsed, but a genuine redelivery of the same click is.
  - Returns `null` when unparseable, missing the operator `userId`, or missing `outTrackId` (the card instance id is required — it is the card ref, the async-update token, and the dedup basis). The connector keeps a defensive `decoded.dedupKey || frame.messageId` fallback matching the message path, though `dedupKey` is always present.

**Connector** (`dingtalk-stream-connector.ts`) `handleFrame`: after the ping/ack/disconnect handling, branch on frame topic. Bot message → existing path. Card callback → `decodeDingtalkCardAction`, dedup via the existing `SeenIdSet` on the namespaced `card:…` key (falling back to `frame.messageId`), `emit` the `ImInboundCardActionEvent` with `messageId = dedupKey`. Ack is unchanged (the generic 200 already sent before the branch); no card-update payload is returned (future consumer's job).

## Idempotent dedup

- **Lark:** shared `seenEventIds` FIFO keyed on `event_id` (globally unique per event, across kinds).
- **DingTalk:** shared `SeenIdSet` keyed on `card:<outTrackId>:<valueHash>` (namespaced so it never collides with message `msgId`s).
- **Router (secondary guard):** unchanged — it keys on `(platform, messageId)` and already covers any event carrying a `messageId`. Card events set `messageId`, so the router's existing dedup applies for free if/when a consumer subscribes.

## Testing

- `lark-inbound-message.test.ts`: `normalizeLarkCardAction` — happy path (chat/sender/value/tag/token/cardRef), missing `action` → null, missing `context` → `channelKey:""`, operator id fallback chain, empty-value-but-tagged button still deliverable.
- `lark-inbound-transport.test.ts`: registering `card.action.trigger` on the dispatcher forwards merged data to `onCardAction`; the handler returns `undefined`.
- `lark-inbound-connector.test.ts`: a `card.action.trigger` frame emits one `card_action` event with the right fields; a duplicate `event_id` is dropped.
- `dingtalk-stream-protocol.test.ts`: `decodeDingtalkCardAction` (happy path, missing userId → null, unparseable `content` → still deliverable via outTrackId, missing outTrackId → null), `isDingtalkCardCallbackFrame`, `buildDingtalkOpenRequest` now lists both topics.
- `dingtalk-stream-connector.test.ts`: a card-callback frame is acked + emits one `card_action` event; a redelivery with the same `card:` key is dropped; a bot-message frame still works unchanged.

## Files

- `src/im/gateway/inbound-event.ts` — union extension.
- `src/im/lark/lark-inbound-message.ts` — `normalizeLarkCardAction`.
- `src/im/lark/lark-inbound-transport.ts` — `onCardAction` + dispatcher registration.
- `src/im/lark/lark-inbound-connector.ts` — card-action handle + emit.
- `src/im/dingtalk/dingtalk-stream-protocol.ts` — topic const, subscription, classify, `decodeDingtalkCardAction`.
- `src/im/dingtalk/dingtalk-stream-connector.ts` — card-callback branch + emit.
- Tests as above.
