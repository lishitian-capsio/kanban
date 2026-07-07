/**
 * Lark IM adapter — outbound (send messages/cards as the bot via `im/v1/messages`, authenticated
 * with a `tenant_access_token` minted from an `app_id`/`app_secret` in the machine-local 0600 store)
 * and inbound (a persistent-connection `im.message.receive_v1` subscription, no public callback URL,
 * normalized into the gateway's neutral events with idempotent `event_id` dedup).
 */

export { LarkApiError, LarkCredentialFormatError } from "./errors";
export { buildLarkMessageResourceUrl, DEFAULT_LARK_BASE_URL } from "./lark-endpoints";
export {
	DEFAULT_LARK_REQUEST_TIMEOUT_MS,
	type LarkBinaryResponse,
	type LarkFetch,
	type LarkRequestOptions,
	larkGetBinary,
	larkPostJson,
} from "./lark-http";
export {
	DEFAULT_LARK_DEDUP_CAPACITY,
	LarkImGatewayConnector,
	type LarkImGatewayConnectorOptions,
	registerLarkImGatewayConnector,
} from "./lark-inbound-connector";
export {
	type NormalizedLarkImageRef,
	type NormalizedLarkInboundMessage,
	normalizeLarkInboundMessage,
	parseLarkInboundEventId,
} from "./lark-inbound-message";
export {
	createLarkWsInboundTransport,
	DEFAULT_LARK_WS_CONNECT_TIMEOUT_MS,
	DEFAULT_LARK_WS_HANDSHAKE_TIMEOUT_MS,
	type LarkInboundTransport,
	type LarkInboundTransportHandlers,
	type LarkWsClientFactory,
	type LarkWsClientLike,
	type LarkWsClientParams,
	LarkWsInboundTransport,
	type LarkWsInboundTransportOptions,
} from "./lark-inbound-transport";
export type { LarkBotCredential, LarkReceiveIdType } from "./lark-message-format";
export {
	buildLarkInteractiveCardContent,
	buildLarkTextMessageContent,
	inferLarkReceiveIdType,
	parseLarkBotCredential,
} from "./lark-message-format";
export type { LarkImProviderOptions } from "./lark-provider";
export { LarkImProvider, registerLarkImProvider } from "./lark-provider";
export {
	DEFAULT_TOKEN_SAFETY_WINDOW_MS,
	FALLBACK_TOKEN_TTL_MS,
	type LarkTenantTokenOptions,
	LarkTenantTokenProvider,
} from "./lark-tenant-token";
