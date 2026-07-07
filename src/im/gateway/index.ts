/**
 * The lightweight resident IM inbound gateway (requirement ac99c): a per-platform long-connection
 * supervisor (Lark WebSocket / DingTalk Stream) that manages connection lifecycle and fans decoded
 * inbound events out to subscribers. Concrete platform connectors self-register via the connector
 * registry (mirrors the outbound provider registry); nothing here speaks a platform protocol.
 */
export type { ImGatewayDeps, ImInboundEventListener } from "./im-gateway";
export { DEFAULT_RECONNECT_DELAYS_MS, ImGateway } from "./im-gateway";
export type { ImConnectionState, ImConnectorContext, ImGatewayConnector } from "./im-gateway-connector";
export {
	getImGatewayConnector,
	listRegisteredImGatewayConnectorPlatforms,
	registerImGatewayConnector,
	unregisterImGatewayConnector,
} from "./im-gateway-connector-registry";
export type { ImInboundEvent, ImInboundImage, ImInboundMessageEvent } from "./inbound-event";
